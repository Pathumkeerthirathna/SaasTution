"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { groupApi, groupUrls, type ApiResult } from "./api";
import { onGroupSync, type GroupSyncDetail } from "./group-sync";

/**
 * Whether Group Activities is available on this server (the breakout
 * feature flag, which lives on the server only). One probe per classroom
 * page: the role's overview route answers 404 while the flag is off, and the
 * Group Activities rail button then never appears. A network error leaves it
 * hidden too (fail closed); nothing else is fetched.
 */
export function useGroupActivitiesAvailable(sessionId: string | undefined, role: "teacher" | "student" | string): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!sessionId || (role !== "teacher" && role !== "student")) return;
    let cancelled = false;
    const urls = groupUrls(sessionId);
    void groupApi(role === "teacher" ? urls.teacherOverview : urls.myGroup).then((result) => {
      if (!cancelled) setAvailable(result.ok);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, role]);
  return available;
}

/** Slow fallback refresh while a panel is open (the live-updates stream may be interrupted). */
export const GROUP_POLL_MS = 20_000;

/**
 * Loads `url` and keeps it fresh: again on every Group Activities ping that
 * `matches` (from the existing live-updates stream), when the window regains
 * focus, and every GROUP_POLL_MS. Responses are applied in request order
 * (a slow old response never overwrites a newer one).
 */
export function useGroupResource<T>(url: string | null, matches: (detail: GroupSyncDetail) => boolean = () => true) {
  const [state, setState] = useState<{ data: T | null; error: ApiResult<T> | null; loading: boolean }>({ data: null, error: null, loading: Boolean(url) });
  const seq = useRef(0);
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  const reload = useCallback(async () => {
    if (!url) return;
    const mine = ++seq.current;
    const result = await groupApi<T>(url);
    if (mine !== seq.current) return;
    setState(result.ok ? { data: result.data, error: null, loading: false } : (current) => ({ data: current.data, error: result, loading: false }));
  }, [url]);

  useEffect(() => {
    if (!url) return;
    setState((current) => ({ ...current, loading: true }));
    void reload();
    const unsubscribe = onGroupSync((detail) => {
      if (matchesRef.current(detail)) void reload();
    });
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => void reload(), GROUP_POLL_MS);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [url, reload]);

  return { ...state, reload, setData: (data: T) => setState({ data, error: null, loading: false }) };
}
