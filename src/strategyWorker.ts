import type { StrategyContext } from './strategy';

type PyodideLike = {
  globals: { set: (name: string, value: unknown) => void; get: (name: string) => unknown };
  runPythonAsync: (code: string) => Promise<unknown>;
};

type RunMessage = { type: 'run'; id: number; code: string; context: StrategyContext };
type IncomingMessage = RunMessage;

const PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v0.28.3/full/';
let pyodidePromise: Promise<PyodideLike> | undefined;

async function getPyodide(): Promise<PyodideLike> {
  if (!pyodidePromise) {
    pyodidePromise = import(/* @vite-ignore */ `${PYODIDE_INDEX_URL}pyodide.mjs`)
      .then(async (module) => module.loadPyodide({ indexURL: PYODIDE_INDEX_URL }) as Promise<PyodideLike>);
  }
  return pyodidePromise;
}

function pythonProgram(): string {
  return `
import json

def buy(symbol, quantity, price=None):
    result = {"action": "order", "side": "buy", "symbol": symbol, "quantity": quantity, "type": "market" if price is None else "limit"}
    if price is not None: result["price"] = price
    return result

def sell(symbol, quantity, price=None):
    result = {"action": "order", "side": "sell", "symbol": symbol, "quantity": quantity, "type": "market" if price is None else "limit"}
    if price is not None: result["price"] = price
    return result

def cancel(order_id):
    return {"action": "cancel", "order_id": order_id}

def cancel_all(symbol=None, side=None):
    result = {"action": "cancel_all"}
    if symbol is not None: result["symbol"] = symbol
    if side is not None: result["side"] = side
    return result

_ctx = json.loads(_finpub_context_json)
_finpub_ns = {"buy": buy, "sell": sell, "cancel": cancel, "cancel_all": cancel_all}
exec(_finpub_code, _finpub_ns)
_finpub_handler = _finpub_ns.get("on_bar")
if not callable(_finpub_handler):
    raise ValueError("Define a callable on_bar(ctx) function.")
_finpub_result_json = json.dumps(_finpub_handler(_ctx))
`;
}

self.onmessage = async (event: MessageEvent<IncomingMessage>) => {
  const message = event.data;
  if (message.type !== 'run') return;
  const started = performance.now();
  try {
    const pyodide = await getPyodide();
    pyodide.globals.set('_finpub_context_json', JSON.stringify(message.context));
    pyodide.globals.set('_finpub_code', message.code);
    await pyodide.runPythonAsync(pythonProgram());
    const raw = pyodide.globals.get('_finpub_result_json');
    const result = JSON.parse(String(raw));
    self.postMessage({ id: message.id, ok: true, result, durationMs: Math.round(performance.now() - started) });
  } catch (error) {
    self.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error), durationMs: Math.round(performance.now() - started) });
  }
};
