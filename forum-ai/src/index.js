export { ForumAiSession } from "./session.js";
export { ForumAiCoordinator } from "./coordinator.js";
export { GovSourceAgent, AcademiaSourceAgent, PressSourceAgent } from "./agents.js";

// The session Durable Object is the only public entry. It is the only
// object that receives the browser request, and the only one that stores
// the Forum cookie.
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path !== "/forum-ai" && !path.startsWith("/forum-ai/")) {
      return new Response("not found", { status: 404 });
    }
    if (!env.SESSION) return new Response("session unavailable", { status: 500 });
    const id = env.SESSION.idFromName("public");
    return env.SESSION.get(id).fetch(request);
  },
};
