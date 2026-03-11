import http from "http";
import https from "https";
import { URL } from "url";

export type AlpacaFailureKind =
  | "target_mismatch"
  | "service_unhealthy"
  | "portfolio_http_error"
  | "portfolio_invalid_json"
  | "health_invalid_json"
  | "unreachable"
  | "unknown";

export type AlpacaDiagnostic = {
  ok: boolean;
  kind?: AlpacaFailureKind;
  title?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  portfolio?: any;
};

function parseMaybeJson(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractErrorMessage(payload: any): string {
  if (payload && typeof payload === "object" && typeof payload.error === "string") return payload.error;
  return "";
}

function request(url: string, timeout = 8000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(
      parsed,
      { headers: { "User-Agent": "cortana-alpaca-heartbeat/1.0" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeout, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

function classifyFromError(payload: any, fallbackKind: AlpacaFailureKind): AlpacaDiagnostic {
  const error = extractErrorMessage(payload);
  const target = payload?.target_environment;
  const environment = payload?.environment;
  const keysPath = payload?.keys_path;
  const keyFingerprint = payload?.key_fingerprint;

  if (/target=live actual=paper|target=.*actual=.*/i.test(error)) {
    return {
      ok: false,
      kind: "target_mismatch",
      title: "Alpaca target/account mismatch",
      summary: `Portfolio heartbeat blocked: target environment ${String(target || "unknown")} does not match actual account environment ${String(environment || "unknown")}.`,
      metadata: { error, target_environment: target, environment, keys_path: keysPath, key_fingerprint: keyFingerprint },
    };
  }

  return {
    ok: false,
    kind: fallbackKind,
    title: "Alpaca service unhealthy",
    summary: error || "Portfolio heartbeat could not read the Alpaca service path.",
    metadata: { error, target_environment: target, environment, keys_path: keysPath, key_fingerprint: keyFingerprint },
  };
}

export function classifyAlpacaResponses(params: {
  portfolioStatus?: number;
  portfolioBody?: string;
  healthStatus?: number;
  healthBody?: string;
  requestError?: string;
}): AlpacaDiagnostic {
  if (params.requestError) {
    return {
      ok: false,
      kind: "unreachable",
      title: "Alpaca service unreachable",
      summary: `Portfolio heartbeat could not reach the local Alpaca service: ${params.requestError}`,
      metadata: { request_error: params.requestError },
    };
  }

  const portfolioJson = parseMaybeJson(params.portfolioBody || "");
  if ((params.portfolioStatus || 0) >= 200 && (params.portfolioStatus || 0) < 300) {
    if (!portfolioJson || typeof portfolioJson !== "object") {
      return {
        ok: false,
        kind: "portfolio_invalid_json",
        title: "Alpaca portfolio returned invalid JSON",
        summary: "Portfolio heartbeat received a non-JSON response from /alpaca/portfolio.",
        metadata: { portfolio_status: params.portfolioStatus },
      };
    }
    return { ok: true, portfolio: portfolioJson };
  }

  if (portfolioJson) return classifyFromError(portfolioJson, "portfolio_http_error");

  const healthJson = parseMaybeJson(params.healthBody || "");
  if (healthJson) return classifyFromError(healthJson, "service_unhealthy");

  if (params.healthBody) {
    return {
      ok: false,
      kind: "health_invalid_json",
      title: "Alpaca health returned invalid JSON",
      summary: "Portfolio heartbeat could not parse /alpaca/health after portfolio failure.",
      metadata: { portfolio_status: params.portfolioStatus, health_status: params.healthStatus },
    };
  }

  return {
    ok: false,
    kind: "unknown",
    title: "Alpaca portfolio path failed",
    summary: "Portfolio heartbeat could not determine the exact Alpaca failure layer.",
    metadata: { portfolio_status: params.portfolioStatus, health_status: params.healthStatus },
  };
}

export async function fetchAlpacaPortfolioDiagnostics(baseUrl = "http://localhost:3033", timeout = 8000): Promise<AlpacaDiagnostic> {
  try {
    const portfolio = await request(`${baseUrl}/alpaca/portfolio`, timeout);
    if (portfolio.status >= 200 && portfolio.status < 300) {
      return classifyAlpacaResponses({ portfolioStatus: portfolio.status, portfolioBody: portfolio.body });
    }

    const health = await request(`${baseUrl}/alpaca/health`, timeout).catch(() => ({ status: 0, body: "" }));
    return classifyAlpacaResponses({
      portfolioStatus: portfolio.status,
      portfolioBody: portfolio.body,
      healthStatus: health.status,
      healthBody: health.body,
    });
  } catch (error) {
    return classifyAlpacaResponses({ requestError: error instanceof Error ? error.message : String(error) });
  }
}
