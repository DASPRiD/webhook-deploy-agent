import type Router from 'koa-tree-router';
import {registerFooRoutes} from './foo.js';

export const registerHelloWorldRoutes = (router : Router) : void => {
    const group = router.newGroup('/hello-world');
    registerFooRoutes(group);
};
