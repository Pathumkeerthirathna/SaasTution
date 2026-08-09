"use client";

import { useState } from "react";
import type { JitsiParticipant } from "../types";

export default function useParticipants() {
  const [participants, setParticipants] = useState<JitsiParticipant[]>([]);

  return {
    participants,
    setParticipants,
  };
}