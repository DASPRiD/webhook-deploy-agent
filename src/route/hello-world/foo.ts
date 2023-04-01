import type {Context} from 'koa';
import type Router from 'koa-tree-router';
import {z} from 'zod';
import {parseBody, parseQuery} from '../../util/zod.js';

const getHelloWorld = (context : Context) => {
    context.body = {message: 'hello-world'};
};

const listQuerySchema = z.object({
    foo: z.string().optional(),
});

const listHelloWorld = (context : Context) => {
    const query = parseQuery(listQuerySchema, context);

    context.body = {foo: query.foo};
};

const listPostSchema = z.object({
    foo: z.string(),
});

const postHelloWorld = (context : Context) => {
    const input = parseBody(listPostSchema, context);

    context.status = 201;
    context.body = {foo: input.foo};
};

export const registerFooRoutes = (router : Router) : void => {
    const group = router.newGroup('/foo');
    group.get('/', getHelloWorld);
    group.get('/list', listHelloWorld);
    group.post('/list', postHelloWorld);
};
