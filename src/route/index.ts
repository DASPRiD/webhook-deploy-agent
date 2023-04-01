import type Router from 'koa-tree-router';
import {registerHelloWorldRoutes} from './hello-world/index.js';

export const registerRoutes = (router : Router) : void => {
    registerHelloWorldRoutes(router);
};
