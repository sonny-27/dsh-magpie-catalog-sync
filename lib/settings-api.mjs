// Registered through connection.fetch so the host retains owner-session authentication.
export function subscriptionRoutes(controller) {
  return [
    ['settings', ['GET'], () => controller.settingsView()],
    ['save', ['POST'], input => controller.updateSettings(input)],
    ['connect', ['POST'], input => controller.updateConnection(input)],
    ['sync', ['POST'], async () => { await controller.sync(); return controller.settingsView(); }],
    ['bindings', ['GET'], () => controller.imageBinding()],
    ['search-policy', ['GET', 'POST'], input => controller.searchPolicy(input)],
    ['diagnostics', ['GET', 'POST'], input => input ? controller.diagnostics.start(input.kind) : controller.diagnostics.view()],
  ].map(([route, methods, action]) => ({
    path: '/api/magpie-subscription-' + route, methods, requestBody: 'buffered',
    fetch: async request => {
      try {
        // Local configuration must load, but the upstream and model relay need not be ready.
        await controller.initialize();
        const input = request.method === 'POST' ? await request.json() : undefined;
        return Response.json(await action(input), { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        return Response.json({ error: String(error.message).replace(/Bearer\s+\S+/gi, '[凭据]') }, { status: 400 });
      }
    },
  }));
}
