"use client";

import { useEffect, useRef, useState } from "react";
import { Send, MessagesSquare } from "lucide-react";

import type { ChatMessage } from "../../types";

type ChatPanelProps = {
  messages: ChatMessage[];
  onSend: (message: string) => void;
};

function fmtTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Realtime meeting chat, backed by Jitsi's own group chat (`sendChatMessage` /
 * `incomingMessage`) — every message goes to everyone in the session.
 */
export default function ChatPanel({ messages, onSend }: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  function handleSend() {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-slate-900">
      {/* Scope note */}
      <div className="flex shrink-0 items-center gap-1.5 rounded-lg border border-emerald-100 bg-emerald-50/60 px-2.5 py-2 text-[11px] text-emerald-700">
        <MessagesSquare size={12} />
        Messages are sent to everyone in the class
      </div>

      {/* Thread */}
      <div
        ref={listRef}
        className="scrollbar-thin min-h-0 flex-1 space-y-2.5 overflow-y-auto py-3 pr-1"
      >
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-slate-400">
            No messages yet. Say hello to start the conversation.
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`flex flex-col ${message.self ? "items-end" : "items-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl border px-3 py-2 text-sm shadow-sm ${
                  message.self
                    ? "rounded-br-sm border-emerald-600 bg-emerald-600 text-white"
                    : "rounded-bl-sm border-slate-200 bg-white text-slate-900"
                }`}
              >
                {!message.self ? (
                  <p className="mb-0.5 text-[11px] font-semibold text-emerald-700">
                    {message.author}
                  </p>
                ) : null}
                <p className="whitespace-pre-wrap break-words">{message.body}</p>
              </div>
              <span className="mt-0.5 px-1 text-[10px] text-slate-400">
                {message.self ? "You" : message.author} · {fmtTime(message.at)}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-slate-200 pt-2.5">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder="Type a message to everyone…"
            className="max-h-24 min-h-[38px] flex-1 resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-emerald-400 focus:bg-white"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!draft.trim()}
            aria-label="Send message"
            className="inline-flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
