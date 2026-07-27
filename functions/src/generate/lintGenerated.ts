/**
 * Robustness lint for GENERATED code — accident detection, not a security
 * boundary. (Security lives in the sandbox/CSP/broker: inspecting untrusted
 * Turing-complete code can always be evaded. What inspection IS good for is
 * catching the model's common MISTAKES — patterns that silently die in the
 * sandboxed preview — and telling the user/model about them.)
 *
 * JS is parsed with a real parser (acorn), not regexes, so the checks survive
 * formatting differences; HTML gets targeted reference checks.
 */
import * as acorn from 'acorn';
import { simple as walk } from 'acorn-walk';

export interface LintWarning {
  path: string;
  message: string;
}

const EXTERNAL_URL = /^https?:\/\//i;

function lintJs(path: string, content: string): LintWarning[] {
  const warnings: LintWarning[] = [];
  const warn = (message: string): void => {
    warnings.push({ path, message });
  };

  let ast: acorn.Node;
  try {
    ast = acorn.parse(content, { ecmaVersion: 2022, sourceType: 'script' });
  } catch {
    try {
      ast = acorn.parse(content, { ecmaVersion: 2022, sourceType: 'module' });
    } catch (err) {
      // A syntax error IS the most valuable warning: the preview will be blank.
      warn(`does not parse as JavaScript (${String((err as Error).message).slice(0, 80)})`);
      return warnings;
    }
  }

  const seen = new Set<string>();
  const once = (key: string, message: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    warn(message);
  };

  interface N {
    type: string;
    name?: string;
    object?: N;
    property?: N & { name?: string };
    callee?: N;
    arguments?: (N & { value?: unknown })[];
    computed?: boolean;
  }
  const isWindowish = (n?: N): boolean =>
    n?.type === 'Identifier' && (n.name === 'window' || n.name === 'globalThis' || n.name === 'self');

  walk(ast, {
    CallExpression(node: unknown) {
      const n = node as N;
      if (n.callee?.type === 'Identifier' && n.callee.name === 'eval') {
        once('eval', 'uses eval() — blocked by the preview CSP; the code will fail');
      }
      // fetch("https://…") to anything external dies in the sandbox.
      if (n.callee?.type === 'Identifier' && n.callee.name === 'fetch') {
        const arg = n.arguments?.[0];
        if (arg?.type === 'Literal' && typeof arg.value === 'string' && EXTERNAL_URL.test(arg.value)) {
          once('extfetch', `fetches external URL ${String(arg.value).slice(0, 60)} — only the Genesis proxy is reachable from the preview`);
        }
      }
      if (
        n.callee?.type === 'MemberExpression' &&
        n.callee.property?.name === 'sendBeacon'
      ) {
        once('beacon', 'uses sendBeacon — network egress is blocked in the preview');
      }
    },
    NewExpression(node: unknown) {
      const n = node as N;
      if (n.callee?.type !== 'Identifier') return;
      if (n.callee.name === 'Function') {
        once('newfn', 'uses new Function() — blocked by the preview CSP');
      }
      if (n.callee.name === 'WebSocket' || n.callee.name === 'EventSource') {
        once('socket', `uses ${n.callee.name} — network egress is blocked in the preview`);
      }
      if (n.callee.name === 'XMLHttpRequest') {
        once('xhr', 'uses XMLHttpRequest — use the window.__GENESIS__ fetch pattern instead');
      }
    },
    MemberExpression(node: unknown) {
      const n = node as N;
      if (isWindowish(n.object) && !n.computed) {
        const prop = n.property?.name;
        if (prop === 'parent' || prop === 'top') {
          once('escape', `accesses window.${prop} — sandbox-escape attempt or mistake; the preview has no accessible parent`);
        }
      }
      if (n.object?.type === 'Identifier' && (n.object.name === 'localStorage' || n.object.name === 'sessionStorage')) {
        once('storage', `uses ${n.object.name} — unavailable in the sandboxed preview; keep state in variables`);
      }
      if (isWindowish(n.object) && (n.property?.name === 'localStorage' || n.property?.name === 'sessionStorage')) {
        once('storage', `uses ${n.property?.name} — unavailable in the sandboxed preview; keep state in variables`);
      }
      if (n.object?.type === 'Identifier' && n.object.name === 'indexedDB') {
        once('idb', 'uses indexedDB — unavailable in the sandboxed preview');
      }
    },
    Identifier(node: unknown) {
      const n = node as N;
      if (n.name === 'indexedDB') once('idb', 'uses indexedDB — unavailable in the sandboxed preview');
    },
  });

  return warnings;
}

function lintHtml(path: string, content: string): LintWarning[] {
  const warnings: LintWarning[] = [];
  const re = /(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    try {
      const host = new URL(m[1]).host;
      if (seen.has(host)) continue;
      seen.add(host);
      warnings.push({
        path,
        message: `references external resource on ${host} — blocked by the preview CSP; inline it or use CSS/emoji/data: URIs`,
      });
    } catch {
      /* unparseable URL — ignore */
    }
  }
  return warnings;
}

/** Lint one generated file by extension. Returns [] for types we don't lint. */
export function lintGeneratedFile(path: string, content: string): LintWarning[] {
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  if (ext === 'js' || ext === 'mjs') return lintJs(path, content);
  if (ext === 'html' || ext === 'htm') return lintHtml(path, content);
  return [];
}
