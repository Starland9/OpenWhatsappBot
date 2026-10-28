// Hooks shared by the shell and by the views.
import { useState, useEffect, useRef, useCallback } from "./html.mjs";
import { onLanguageChange, getLanguage } from "../i18n.mjs";
import { currentRoute, onRoute } from "../router.mjs";
import { live } from "../live.mjs";
import { setDirty, toastError } from "../ui.mjs";

/** Re-render when a store (ui.mjs `createStore`) changes; returns its current state. */
export function useStore(store) {
  const [state, setState] = useState(store.get());
  useEffect(() => {
    setState(store.get());
    return store.subscribe(setState);
  }, [store]);
  return state;
}

/** Re-render when the panel language changes (so `t()` results are refreshed). */
export function useLanguage() {
  const [lang, setLang] = useState(getLanguage());
  useEffect(() => onLanguageChange(setLang), []);
  return lang;
}

/** The current hash route `{ name, rest, query, path }`. */
export function useRoute() {
  const [route, setRoute] = useState(currentRoute());
  useEffect(() => {
    setRoute(currentRoute());
    return onRoute(setRoute);
  }, []);
  return route;
}

/** Subscribe to a live topic for the lifetime of the component (`state`, `pairing`, `log`, `job`, `connection`). */
export function useLive(topic, handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => live.subscribe(topic, (payload) => ref.current(payload)), [topic]);
}

/**
 * Run an async loader, keep `{ data, error, loading }`, expose `reload()`. The loader receives nothing;
 * re-runs when `deps` change. A stale answer (a newer run started meanwhile) is ignored.
 */
export function useAsync(loader, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const run = useRef(0);
  const reload = useCallback(async () => {
    const id = ++run.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await loader();
      if (id === run.current) setState({ data, error: null, loading: false });
      return data;
    } catch (error) {
      if (id === run.current) setState((s) => ({ data: s.data, error, loading: false }));
      return null;
    }
  }, deps); // eslint-disable-line
  useEffect(() => {
    reload();
    return () => {
      run.current++;
    };
  }, [reload]);
  return { ...state, reload };
}

/** Mark a form as holding unsaved input while `dirty` is true (warns before navigation or reload). */
export function useUnsavedGuard(key, dirty) {
  useEffect(() => {
    setDirty(key, Boolean(dirty));
    return () => setDirty(key, false);
  }, [key, dirty]);
}

/** `const [busy, run] = useAction()`: `run(fn)` runs an async action, toasts an ApiError, returns its result or null. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, { silent = false } = {}) => {
    setBusy(true);
    try {
      return await fn();
    } catch (error) {
      if (!silent) toastError(error);
      return null;
    } finally {
      setBusy(false);
    }
  }, []);
  return [busy, run];
}
