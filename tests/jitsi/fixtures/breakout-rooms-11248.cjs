/*
 * Breakout rooms list as reported by Jitsi Meet 2.0.11248 (staging).
 *
 * Captured in the teacher's Jitsi iframe console:
 *   APP.store.getState()['features/breakout-rooms'].rooms["<room id>"].participants
 *
 * CAPTURED (verbatim): `capturedParticipants`. The room ID is the one in the
 * captured participant key ("0abad041-7a70-4fec-8ace-2db4bbaf1fee"); the console
 * command as first transcribed read "...-4fec-ace8-...", a typo.
 *
 * CAPTURED (verbatim, local testing, main room): `capturedFocus`, Jicofo's focus
 * occupant, which Jitsi lists without a name in the main and breakout rooms.
 *
 * NOT CAPTURED (synthetic, for the tests only): the room envelopes (id, jid, name,
 * isMainRoom) around the captured participants. The main room's jid is the room
 * of the captured focus key.
 */

"use strict";

const ROOM_ID = "0abad041-7a70-4fec-8ace-2db4bbaf1fee";
const MAIN_ROOM_JID = "saastution-e5225c83-ms72ryze@conference.meet.slclassroom.live";

const capturedFocus = {
    "saastution-e5225c83-ms72ryze@conference.meet.slclassroom.live/focus": {
        jid: "focus@auth.meet.slclassroom.live/focus",
        role: "moderator"
    }
};

const FOCUS_KEY = Object.keys(capturedFocus)[0];
const FOCUS_JID = capturedFocus[FOCUS_KEY].jid;

const capturedParticipants = {
    "0abad041-7a70-4fec-8ace-2db4bbaf1fee@breakout.meet.slclassroom.live/d92a7329": {
        displayName: "Lahiru Rathnayake",
        jid: "d92a7329-ee44-47f1-892e-cdf14f0e8c07@meet.slclassroom.live/tw79LuAQTEIU",
        role: "participant",
        userContext: undefined
    }
};

const CAPTURED_KEY = Object.keys(capturedParticipants)[0];
const CAPTURED_JID = capturedParticipants[CAPTURED_KEY].jid;
const CAPTURED_PARTICIPANT_ID = "d92a7329";
const CAPTURED_JID_RESOURCE = "tw79LuAQTEIU";

// The store form (listBreakoutRooms()): room id -> room. Synthetic envelope.
function storeRooms() {
    return {
        "main-room-id": {
            id: "main-room-id",
            jid: MAIN_ROOM_JID,
            name: "",
            isMainRoom: true,
            participants: { ...capturedFocus }
        },
        [ROOM_ID]: {
            id: ROOM_ID,
            jid: `${ROOM_ID}@breakout.meet.slclassroom.live`,
            name: "Room 1",
            isMainRoom: false,
            participants: { ...capturedParticipants }
        }
    };
}

module.exports = {
    ROOM_ID,
    MAIN_ROOM_JID,
    FOCUS_KEY,
    FOCUS_JID,
    capturedFocus,
    CAPTURED_KEY,
    CAPTURED_JID,
    CAPTURED_PARTICIPANT_ID,
    CAPTURED_JID_RESOURCE,
    capturedParticipants,
    storeRooms,
    // The breakoutRoomsUpdated event form: { rooms }.
    eventPayload: () => ({ rooms: storeRooms() })
};
