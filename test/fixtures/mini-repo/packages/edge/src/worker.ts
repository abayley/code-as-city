/** Edge worker serving the mini application. */
export default {
    fetch(): Response {
        return new Response("mini-edge");
    },
};
