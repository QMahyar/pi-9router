/**
 * Web tool implementations: embeddings, web search, web fetch — the HTTP
 * execution logic behind nr_embed / nr_web_search / nr_web_fetch.
 * Registration wrappers live in tools-register.ts.
 */

import { TIMEOUT, postJson } from "./shared.ts";
import { truncateResult } from "./toolkit.ts";

/** Split an embeddings input on a lone `---` line into chunks. */
export function splitEmbedInput(input: string): string[] {
  return input.includes("\n---\n")
    ? input
        .split("\n---\n")
        .map((s) => s.trim())
        .filter(Boolean)
    : [input];
}

export interface EmbedRunResult {
  text?: string;
  details?: Record<string, unknown>;
  error?: string;
  errorDetails?: Record<string, unknown>;
  usage?: { status?: number; count?: number };
}

export async function runEmbed(opts: {
  ep: string;
  key: string;
  model: string;
  input: string;
  dimensions?: number;
  full?: boolean;
  signal?: AbortSignal;
  onUpdate?: (msg: string) => void;
}): Promise<EmbedRunResult> {
  const { ep, key, model, input, signal, onUpdate } = opts;
  const parts = splitEmbedInput(input);
  onUpdate?.(`Embedding ${parts.length} input(s)…`);
  const body: Record<string, unknown> = {
    model,
    input: parts.length === 1 ? parts[0] : parts,
  };
  if (opts.dimensions) body.dimensions = opts.dimensions;
  const res = await postJson(`${ep}/v1/embeddings`, key, body, {
    signal,
    timeoutMs: TIMEOUT.tool,
  });
  if (!res.ok) {
    return {
      error: `Embeddings failed (${res.status}): ${res.error}`,
      errorDetails: { model },
      usage: { status: res.status },
    };
  }
  const data = Array.isArray(res.data?.data) ? res.data.data : [];
  if (!data.length) {
    return {
      error: "Embeddings returned no vectors.",
      errorDetails: { model, inputs: parts.length },
    };
  }
  const lines = [
    `Model: ${model}`,
    `Inputs: ${parts.length}`,
    `Vectors: ${data.length}`,
  ];
  for (const row of data) {
    const vec: number[] = row.embedding || [];
    lines.push(
      `#${row.index ?? "?"} dim=${vec.length} preview=[${vec
        .slice(0, 8)
        .map((x: number) => x.toFixed(5))
        .join(", ")}${vec.length > 8 ? ", …" : ""}]`,
    );
  }
  const details: Record<string, unknown> = {
    model,
    count: data.length,
    dimensions: data[0]?.embedding?.length,
  };
  // Cap full vectors to avoid context blowups even when requested
  if (opts.full) {
    const maxFull = 8;
    details.embeddings = data.slice(0, maxFull).map((d: any) => d.embedding);
    if (data.length > maxFull) {
      details.embeddingsTruncated = true;
      lines.push(`(full vectors capped at ${maxFull} of ${data.length})`);
    }
  }
  return { text: lines.join("\n"), details, usage: { count: data.length } };
}

export interface WebSearchRunResult {
  text?: string;
  details?: Record<string, unknown>;
  error?: string;
  errorDetails?: Record<string, unknown>;
  usage?: { status?: number; count?: number };
}

export async function runWebSearch(opts: {
  ep: string;
  key: string;
  model: string;
  query: string;
  max_results?: number;
  search_type?: string;
  country?: string;
  language?: string;
  time_range?: string;
  domain_filter?: string;
  signal?: AbortSignal;
  onUpdate?: (msg: string) => void;
}): Promise<WebSearchRunResult> {
  const { ep, key, model, query, signal, onUpdate } = opts;
  // Wire: bare provider ("exa"), not catalog id ("exa/search")
  const apiModel = model.replace(/\/search$/i, "");
  onUpdate?.(`Searching · ${apiModel}`);
  const body: Record<string, unknown> = {
    model: apiModel,
    query,
    max_results: opts.max_results ?? 5,
  };
  if (opts.search_type) body.search_type = opts.search_type;
  if (opts.country) body.country = opts.country;
  if (opts.language) body.language = opts.language;
  if (opts.time_range) body.time_range = opts.time_range;
  if (opts.domain_filter) body.domain_filter = opts.domain_filter;
  const res = await postJson(`${ep}/v1/search`, key, body, {
    signal,
    timeoutMs: TIMEOUT.tool,
  });
  if (!res.ok) {
    return {
      error: `Search failed (${res.status}): ${res.error}`,
      errorDetails: { model, query },
      usage: { status: res.status },
    };
  }
  const results = res.data?.results || res.data?.data || [];
  const lines = [
    `Query: ${query}`,
    `Model: ${res.data?.provider || model}`,
    `Results: ${Array.isArray(results) ? results.length : 0}`,
    "",
  ];
  if (Array.isArray(results)) {
    results.forEach((r: any, i: number) => {
      lines.push(`### ${i + 1}. ${r.title || r.url || "result"}`);
      if (r.url) lines.push(r.url);
      if (r.snippet || r.content) lines.push(String(r.snippet || r.content));
      lines.push("");
    });
  } else {
    lines.push(JSON.stringify(res.data, null, 2).slice(0, 8000));
  }
  if (res.data?.answer) lines.push("Answer:", String(res.data.answer));
  const text = await truncateResult(
    lines.join("\n").trim(),
    "web-search",
    "head",
  );
  return {
    text,
    details: {
      model,
      query,
      resultCount: Array.isArray(results) ? results.length : 0,
      urls: Array.isArray(results)
        ? results.map((r: any) => r.url).filter(Boolean)
        : [],
    },
    usage: { count: Array.isArray(results) ? results.length : 0 },
  };
}

export interface WebFetchRunResult {
  text?: string;
  details?: Record<string, unknown>;
  error?: string;
  errorDetails?: Record<string, unknown>;
  usage?: { status?: number; bytes?: number };
}

export async function runWebFetch(opts: {
  ep: string;
  key: string;
  model: string;
  url: string;
  format?: string;
  max_characters?: number;
  signal?: AbortSignal;
  onUpdate?: (msg: string) => void;
}): Promise<WebFetchRunResult> {
  const { ep, key, model, url, signal, onUpdate } = opts;
  const apiModel = model.replace(/\/fetch$/i, "");
  if (!/^https?:\/\//i.test(url)) {
    return { error: "url must be absolute http(s)", errorDetails: {} };
  }
  onUpdate?.(`Fetching · ${url}`);
  const body: Record<string, unknown> = {
    model: apiModel,
    url,
    format: opts.format || "markdown",
  };
  if (opts.max_characters != null) body.max_characters = opts.max_characters;
  let res = await postJson(`${ep}/v1/web/fetch`, key, body, {
    signal,
    timeoutMs: TIMEOUT.tool,
  });
  if (!res.ok && res.status === 404) {
    res = await postJson(`${ep}/v1/fetch`, key, body, {
      signal,
      timeoutMs: TIMEOUT.tool,
    });
  }
  if (!res.ok) {
    return {
      error: `Fetch failed (${res.status}): ${res.error}`,
      errorDetails: { model, url },
      usage: { status: res.status },
    };
  }
  const data = res.data || {};
  const contentObj = data.content;
  const textBody =
    typeof contentObj === "string"
      ? contentObj
      : contentObj?.text ||
        data.markdown ||
        data.text ||
        data.raw_content ||
        "";
  const header = [
    `URL: ${data.url || url}`,
    data.title ? `Title: ${data.title}` : "",
    `Model: ${data.provider || model}`,
  ]
    .filter(Boolean)
    .join("\n");
  const bodyText = textBody || JSON.stringify(data, null, 2).slice(0, 12000);
  const text = await truncateResult(
    `${header}\n\n${bodyText}`,
    "web-fetch",
    "head",
  );
  return {
    text,
    details: {
      model,
      url,
      title: data.title,
      length: contentObj?.length ?? bodyText.length,
    },
    usage: { bytes: bodyText.length },
  };
}
