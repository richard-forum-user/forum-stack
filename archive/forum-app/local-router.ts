/**
 * local-router.ts
 * Internal reverse proxy sitting behind the single Cloudflare Tunnel.
 * Routes traffic to isolated CSS containers based on x-session-id.
 */

import express, { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { getPortForSession } from './container-manager'; 

const app = express();
const ROUTER_PORT = Number(process.env.ROUTER_PORT ?? 8080);

// Proxy middleware for Pod traffic
app.use('/api/pod', async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = req.headers['x-session-id'] as string || req.query.sessionId as string;

  if (!sessionId) {
    res.status(400).json({ error: 'Missing x-session-id header' });
    return;
  }

  try {
    // Dynamically look up the 127.0.0.1 port bound to this session's container
    const targetPort = await getPortForSession(sessionId);
    
    if (!targetPort) {
      res.status(404).json({ error: 'Pod offline or container not found' });
      return;
    }

    const targetUrl = `http://127.0.0.1:${targetPort}`;

    const proxy = createProxyMiddleware({
      target: targetUrl,
      changeOrigin: true,
      pathRewrite: { '^/api/pod': '' }, // Strip /api/pod before passing to CSS
      logLevel: 'warn',
    });

    return proxy(req, res, next);
  } catch (err) {
    console.error(`[local-router] Routing error for session ${sessionId}:`, err);
    res.status(500).json({ error: 'Internal routing error' });
  }
});

app.listen(ROUTER_PORT, () => {
  console.log(`[local-router] Internal proxy listening on host port ${ROUTER_PORT}`);
  console.log(`[local-router] Point your cloudflared tunnel to http://localhost:${ROUTER_PORT}`);
});