import { createServer } from "node:http";

import type { ZodType } from "zod";

import { logger } from "../utils/logger.ts";
import { jsonrepair } from "jsonrepair";

export type AgentResult<T> = {
  result: T;
  receivedAt: string;
};

export type ResultServer<T> = {
  url: string;
  waitForResult: Promise<AgentResult<T>>;
  close: () => Promise<void>;
};

export async function startResultServer<T>(
  schema: ZodType<T> | undefined,
  port?: number,
): Promise<ResultServer<T>> {
  let resolveResult: (value: AgentResult<T>) => void;
  let rejectResult: (reason?: Error) => void;
  let isClosed = false;

  const waitForResult = new Promise<AgentResult<T>>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const server = createServer((req, res) => {
    req.on("error", (error) => {
      logger.error(`Result server request error: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("Invalid request stream.");
      }
      rejectResult(error);
    });

    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }

    const requestUrl = new URL(req.url ?? "", "http://127.0.0.1");
    if (requestUrl.pathname !== "/agent-result") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8").trim();
      const contentType = req.headers["content-type"] ?? "";
      const parsed = parseResultBody(contentType, body);

      if (parsed.error) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(parsed.error);
        return;
      }

      let resultValue: T;
      if (schema) {
        const validated = schema.safeParse(parsed.value);
        if (!validated.success) {
          const issue = validated.error.issues[0]?.message ?? "Invalid result payload.";
          res.writeHead(400, { "content-type": "text/plain" });
          res.end(issue);
          return;
        }
        resultValue = validated.data;
      } else {
        resultValue = parsed.value as T;
      }

      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");

      resolveResult({
        result: resultValue,
        receivedAt: new Date().toISOString(),
      });

      server.close(() => {
        isClosed = true;
      });
    });
  });

  server.on("error", (error) => {
    logger.error(`Result server error: ${error.message}`);
    rejectResult(error);
  });

  const resolvedPort = await new Promise<number>((resolve, reject) => {
    server.listen(port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to determine result server port."));
        return;
      }
      resolve(address.port);
    });
  });

  const url = buildCallbackUrl(resolvedPort);
  logger.info(`Result server listening at ${url}`);

  return {
    url,
    waitForResult,
    close: async () => {
      if (isClosed) return;
      await new Promise<void>((resolve) => {
        server.close(() => {
          isClosed = true;
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}

function parseResultBody(contentType: string, body: string): { value?: unknown; error?: string } {
  if (contentType.includes("application/json")) {
    try {
      const payload = JSON.parse(jsonrepair(body)) as unknown;
      return { value: payload };
    } catch {
      return { error: "Invalid JSON payload. Provide a valid JSON object." };
    }
  }
  return { value: body.trim() };
}

function buildCallbackUrl(port: number): string {
  return `http://127.0.0.1:${port}/agent-result`;
}
