"use client";

import dynamic from "next/dynamic";

// The Excalidraw bundle is only downloaded when a whiteboard is actually shown.
const WhiteboardCanvasLazy = dynamic(() => import("./WhiteboardCanvas"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[240px] items-center justify-center text-[13px] text-slate-500">
      Loading whiteboard...
    </div>
  ),
});

export default WhiteboardCanvasLazy;
