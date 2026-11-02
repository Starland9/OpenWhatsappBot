// The bounded status poller of one message (feature 004, contracts/panel-ui.md 7.8): the ONLY file of the area that may
// use a timer. A `setTimeout` chain, armed from the effect and from each completed poll (never from render), driven by
// `nextPollDelay` (2 s for the first 15 polls, then 10 s, no more than 60 polls, none once the message is settled).
// The attempt counter lives in a ref, the effect depends on the primitive `id` only, the timer is cleared on unmount and
// an answer arriving after it is dropped. Three errors in a row stop the chain, a 404 stops it at once; `refresh()`
// polls now and restarts the counter. No new live topic exists: the status is polled.
import { useCallback, useEffect, useRef, useState } from "../components/index.mjs";
import { api } from "../api.mjs";
import { nextPollDelay, POLL } from "./api-logic.mjs";

const base = "/admin/api/api";
const MAX_ERRORS = 3;

/** `useMessage({ id, initial, timers })` -> `{ message, error, loading, polling, refresh }` */
export function useMessage({ id, initial = null, timers } = {}) {
  const [view, setView] = useState({ message: initial, error: null, loading: !initial, polling: true });
  const timersRef = useRef(timers);
  const attempt = useRef(0);
  const errors = useRef(0);
  const latest = useRef(initial);
  const handle = useRef(null);
  const poller = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const clock = timersRef.current || { setTimeout: (...args) => globalThis.setTimeout(...args), clearTimeout: (...args) => globalThis.clearTimeout(...args) };
    attempt.current = 0;
    errors.current = 0;

    const stop = () => {
      if (handle.current !== null) clock.clearTimeout(handle.current);
      handle.current = null;
    };
    const arm = () => {
      if (cancelled) return;
      // no answer yet (the first polls failed): the message is not settled, only the error count and the poll cap stop the chain
      const delay = nextPollDelay(attempt.current, latest.current || { status: "queued" });
      if (delay === null) {
        setView((current) => ({ ...current, polling: false }));
        return;
      }
      handle.current = clock.setTimeout(poll, delay);
    };
    async function poll() {
      handle.current = null;
      attempt.current += 1;
      let answer;
      try {
        answer = await api("GET", `${base}/messages/${encodeURIComponent(id)}`);
      } catch (error) {
        if (cancelled) return;
        errors.current += 1;
        const gone = error && (error.code === "not_found" || error.status === 404);
        if (gone || errors.current >= MAX_ERRORS) {
          setView((current) => ({ ...current, error, loading: false, polling: false }));
          return;
        }
        setView((current) => ({ ...current, error, loading: false }));
        arm();
        return;
      }
      if (cancelled) return;
      errors.current = 0;
      latest.current = answer.message;
      setView({ message: answer.message, error: null, loading: false, polling: true });
      arm();
    }
    poller.current = () => {
      stop();
      attempt.current = 0;
      errors.current = 0;
      setView((current) => ({ ...current, error: null, loading: !latest.current, polling: true }));
      return poll();
    };

    if (initial) handle.current = clock.setTimeout(poll, POLL.fastMs);
    else poll();
    return () => {
      cancelled = true;
      stop();
      poller.current = null;
    };
  }, [id]);

  const refresh = useCallback(() => (poller.current ? poller.current() : null), []);
  return { message: view.message, error: view.error, loading: view.loading, polling: view.polling, refresh };
}
