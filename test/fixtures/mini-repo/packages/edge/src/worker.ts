import { routes } from "./api/routes.ts";

/** Edge worker serving the mini application. */
export default {
    fetch(request: Request): Response {
        return new Response(routes(new URL(request.url).pathname));
    },
};
