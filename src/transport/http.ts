import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { createServer as createNodeHttpServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type ServerFactory = () => McpServer;

function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    process.stderr.write(`[vault-engine] ${req.method} ${req.path} ${res.statusCode} ${duration}ms\n`);
  });
  next();
}

export function createHttpApp(serverFactory: ServerFactory): Express {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const app = express();

  app.use(express.json());
  app.use(requestLogger);

  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId) {
      const transport = sessions.get(sessionId);
      if (!transport) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // No session ID — create new McpServer + transport for this session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        sessions.set(id, transport);
      },
    });

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };

    try {
      const server = serverFactory();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
      await transport.close().catch(() => {});
      process.stderr.write(`[vault-engine] HTTP error: ${err instanceof Error ? err.message : err}\n`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'mcp-session-id header required' });
      return;
    }
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: 'mcp-session-id header required' });
      return;
    }
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    sessions.delete(sessionId);
    await transport.handleRequest(req, res);
    await transport.close().catch(() => {});
  });

  return app;
}

export async function startHttpTransport(
  serverFactory: ServerFactory,
  port: number,
): Promise<{ app: Express; httpServer: Server }> {
  const app = createHttpApp(serverFactory);

  return new Promise((resolve) => {
    const httpServer = createNodeHttpServer(app);
    httpServer.listen(port, () => {
      process.stderr.write(`[vault-engine] HTTP listening on http://localhost:${port}/mcp\n`);
      resolve({ app, httpServer });
    });
  });
}
