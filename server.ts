import "dotenv/config";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import agentRouter from "./api/agent";

const port = Number(process.env.PORT || 8080);
const allowedOrigins = new Set(
  (process.env.AGENT_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

export const app = express();

app.disable("x-powered-by");
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.get("origin");
  if (!origin) {
    return next();
  }

  if (!allowedOrigins.has(origin)) {
    return res.status(403).json({ error: "Origin is not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Desktop-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  return next();
});
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});
app.use("/api/agent", agentRouter);

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  app.listen(port, () => {
    console.log(`Iris Agent listening on port ${port}`);
  });
}
