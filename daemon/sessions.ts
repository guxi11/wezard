// Persisted principal → claude session_id map. Single JSON file, write-through.
import { loadJsonMap, type JsonMap } from "../shared/json-map-store.js";

export type SessionStore = JsonMap<string>;

export const loadSessionStore = (filePath: string): SessionStore => loadJsonMap<string>(filePath);
