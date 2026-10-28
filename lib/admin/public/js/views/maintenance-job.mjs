// Following a long operation of the maintenance page (update.check, update.apply, ytdlp.update): the job answer
// comes over the live stream (`job` events) or, as a safety net, by polling JOB-1, and the last event of each job
// is kept by id so one that arrives before the POST answer is not lost. Same approach as the dashboard's restart.

import { useState, useEffect, useRef, useLive } from "../components/index.mjs";
import { api } from "../api.mjs";
import { live } from "../live.mjs";

const POLL_MS = 3000;

/**
 * `const [job, follow] = useJobFollower(["update.apply"], onSettled)`.
 *   job        the running job (the last event seen), or null
 *   follow(j)  start following the job a POST answered with
 *   onSettled(job)   called once with the final event (`done` or `failed`) of the followed job
 */
export function useJobFollower(types, onSettled) {
  const [job, setJob] = useState(null);
  const seen = useRef(new Map());
  const watching = useRef(null);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  const settle = (event) => {
    if (!event || event.id !== watching.current) return;
    if (event.status === "running") {
      setJob(event);
      return;
    }
    watching.current = null;
    setJob(null);
    settledRef.current(event);
  };

  useLive("job", (event) => {
    if (!event || !types.includes(event.type)) return;
    seen.current.set(event.id, event);
    settle(event);
  });

  // a job that is being followed is also asked for now and then: an event lost in a reconnection never hangs the page
  useEffect(() => {
    if (!job) return undefined;
    const unwatch = live.watchJob(job.id);
    const timer = setInterval(() => {
      api("GET", `/admin/api/jobs/${job.id}`)
        .then((answer) => settle(answer.job))
        .catch(() => {});
    }, POLL_MS);
    return () => {
      unwatch();
      clearInterval(timer);
    };
  }, [job && job.id]);

  const follow = (started) => {
    watching.current = started.id;
    settle(seen.current.get(started.id) || started);
  };
  return [job, follow];
}
