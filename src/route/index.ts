import {exec} from 'child_process';
import {createHash, createHmac} from 'crypto';
import {createWriteStream} from 'fs';
import {mkdir, readlink, rm, symlink, unlink, readFile} from 'fs/promises';
import {join} from 'path';
import {pipeline} from 'stream/promises';
import config from 'config';
import type Router from 'koa-tree-router';
import type {RouterContext} from 'koa-tree-router';
import getRawBody from 'raw-body';
import yaml from 'yaml';
import yauzl from 'yauzl-promise';
import {z} from 'zod';

// eslint-disable-next-line import/no-named-as-default-member
const zipFromBuffer = yauzl.fromBuffer;

type Target = {
    repository : string;
    secret : string;
    baseDir : string;
};

const targets = config.get<Target[]>('targets');

const deployToDirectory = async (zipBuffer : Buffer, path : string) : Promise<void> => {
    await mkdir(path, {recursive: true});

    const zipFile = await zipFromBuffer(zipBuffer);

    await zipFile.walkEntries(async entry => {
        if (entry.fileName.endsWith('/')) {
            await mkdir(join(path, entry.fileName), {recursive: true});
            return;
        }

        const writeStream = createWriteStream(join(path, entry.fileName));
        const readStream = await entry.openReadStream();

        await pipeline(
            readStream,
            writeStream,
        );

        writeStream.close();
    });

    await zipFile.close();
};

const commandSchema = z.object({
    command: z.string(),
    cwd: z.string().optional(),
});

type Command = z.infer<typeof commandSchema>;

const deploySchema = z.object({
    shared: z.object({
        files: z.array(z.string()).optional(),
        dirs: z.array(z.string()).optional(),
    }).optional(),
    prePublish: z.array(commandSchema).optional(),
    postPublish: z.array(commandSchema).optional(),
});

type DeployConfig = z.infer<typeof deploySchema>;

const getDeployConfig = async (deployDir : string) : Promise<DeployConfig | null> => {
    const configPath = join(deployDir, 'deploy.yaml');
    let rawConfig = null;

    try {
        rawConfig = await readFile(configPath, {encoding: 'utf-8'});
    } catch {
        return null;
    }

    await rm(configPath);
    const parsedConfig = yaml.parse(rawConfig) as unknown;
    return deploySchema.parse(parsedConfig);
};

const setupShared = async (
    config : NonNullable<DeployConfig['shared']>,
    deployDir : string,
    sharedDir : string,
) : Promise<void> => {
    if (config.files) {
        for (const path of config.files) {
            await symlink(join(sharedDir, path), join(deployDir, path), 'file');
        }
    }

    if (config.dirs) {
        for (const path of config.dirs) {
            await symlink(join(sharedDir, path), join(deployDir, path), 'dir');
        }
    }
};

class ExecCommandError extends Error {
    public constructor(message : string, public readonly stdout : string, public readonly stderr : string) {
        super(message);
    }
}

const execCommand = async (command : Command, baseDir : string) : Promise<string> => {
    return new Promise((resolve, reject) => {
        exec(
            command.command,
            {cwd: command.cwd ? join(baseDir, command.cwd) : baseDir},
            (error, stdout, stderr) => {
                if (error) {
                    reject(new ExecCommandError(error.message, stdout, stderr));
                    return;
                }

                resolve(stdout);
            }
        );
    });
};

type ExecCommandsResult = {
    out : string;
    success : boolean;
};

const execCommands = async (commands : Command[], baseDir : string) : Promise<ExecCommandsResult> => {
    const out = [];

    for (const command of commands) {
        if (command.cwd) {
            out.push(`CWD: ${command.cwd}`);
        }

        out.push(`$ ${command.command}`);

        try {
            out.push(`> ${await execCommand(command, baseDir)}`);
        } catch (error) {
            if (!(error instanceof ExecCommandError)) {
                throw error;
            }

            out.push(`> ${error.stdout}`);
            out.push(`! ${error.stderr}`);

            return {
                out: out.join('\n'),
                success: false,
            };
        }
    }

    return {
        out: out.join('\n'),
        success: true,
    };
};

const handleDeploy = async (context : RouterContext) => {
    const repository = context.get('x-webhook-repository');
    const target = targets.find(target => target.repository.toLowerCase() === repository.toLowerCase());

    if (!target) {
        context.status = 400;
        context.body = {message: 'Unknown repository'};
        return;
    }

    const {secret, baseDir} = target;
    const requestUrl = new URL(context.URL.toString());
    requestUrl.searchParams.sort();

    const zipBuffer = await getRawBody(context.req);
    const zipHash = createHash('sha256').update(zipBuffer).digest('hex');

    const runId = context.get('x-webhook-run-id');
    const canonicalRequest = [
        requestUrl.pathname,
        requestUrl.searchParams.toString(),
    ].join('\n');
    const timestamp = context.get('x-webhook-timestamp');
    const stringToSign = [
        'Deploy-HMAC-SHA256',
        timestamp,
        repository,
        runId,
        createHash('sha256').update(canonicalRequest).digest('hex'),
        zipHash,
    ].join('\n');

    const signature = createHmac('sha256', secret).update(stringToSign).digest('hex');
    const requestSignature = context.get('x-webhook-signature');

    if (signature !== requestSignature) {
        context.status = 403;
        context.body = {message: 'Signature mismatch'};
        return;
    }

    if ((Date.now() / 1000) - (new Date(timestamp).getTime() / 1000) > 60) {
        context.status = 403;
        context.body = {message: 'Signature expired'};
        return;
    }

    const deployDir = join(baseDir, `build-${runId}`);
    const currentDir = join(baseDir, 'current');
    const nextDir = join(baseDir, 'next');
    await deployToDirectory(zipBuffer, deployDir);
    let deployConfig;

    try {
        deployConfig = await getDeployConfig(deployDir);
    } catch (error) {
        context.status = 400;
        context.body = {
            message: 'Failed to read deploy config',
            out: JSON.stringify(error),
        };
        return;
    }

    try {
        // In case a previous deployment failed
        await unlink(nextDir);
    } catch {
        // Noop
    }

    await symlink(deployDir, nextDir, 'dir');

    if (deployConfig?.shared) {
        await setupShared(deployConfig.shared, deployDir, join(baseDir, 'shared'));
    }

    const out = [];

    if (deployConfig?.prePublish) {
        out.push('-----------');
        out.push('Pre-Publish');
        out.push('-----------');

        const result = await execCommands(deployConfig.prePublish, baseDir);
        out.push(result.out);

        if (!result.success) {
            context.status = 400;
            context.body = {
                message: 'Pre-Publish failed',
                out: out.join('\n'),
            };
            return;
        }
    }

    let previousDir = null;

    try {
        previousDir = await readlink(currentDir);
        await unlink(currentDir);
    } catch {
        // Noop
    }

    await symlink(deployDir, currentDir, 'dir');
    await unlink(nextDir);

    if (deployConfig?.postPublish) {
        out.push('------------');
        out.push('Post-Publish');
        out.push('------------');

        const result = await execCommands(deployConfig.postPublish, baseDir);
        out.push(result.out);

        if (!result.success) {
            context.status = 400;
            context.body = {
                message: 'Post-Publish failed',
                out: out.join('\n'),
            };
            return;
        }
    }

    if (previousDir && previousDir !== deployDir) {
        await rm(previousDir, {recursive: true, force: true});
    }

    context.status = 200;
    context.body = {
        out: out.join('\n'),
    };
};

export const registerRoutes = (router : Router) : void => {
    router.post('/', handleDeploy);
};
