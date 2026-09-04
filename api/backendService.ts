import type { RequestHandler } from "express";
import agentRouter from "./agent";

export const DEFAULT_BACKEND_SERVICE = "iris-agent";

const normalizeBackendService = (value: string | undefined): string =>
  (value || DEFAULT_BACKEND_SERVICE).trim().toLowerCase();

export const resolveBackendService = (): string =>
  normalizeBackendService(process.env.IRIS_BACKEND_SERVICE);

export const getBackendApiRouter = (): RequestHandler => {
  const backendService = resolveBackendService();

  switch (backendService) {
    case "iris-agent":
      return agentRouter;
    default:
      console.warn(
        `[server] Unknown IRIS_BACKEND_SERVICE='${backendService}', falling back to '${DEFAULT_BACKEND_SERVICE}'.`,
      );
      return agentRouter;
  }
};
