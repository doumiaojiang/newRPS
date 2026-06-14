import React from "react";
import { createRoot } from "react-dom/client";
import { io } from "socket.io-client";
import { App } from "./App";
import "./styles.css";

export const socket = io({
  autoConnect: false,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 800,
  reconnectionDelayMax: 5_000,
  transports: ["websocket", "polling"],
  withCredentials: true,
  timeout: 20_000
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
