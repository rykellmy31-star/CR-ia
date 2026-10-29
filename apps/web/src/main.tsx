import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/app.css";

// Safari no iPhone pode ignorar user-scalable=no em gestos de pinça.
// Bloqueamos somente os eventos de zoom no dispositivo touch, sem impedir
// a rolagem vertical nem o scroll horizontal dos seletores de provedores.
if (window.matchMedia("(pointer: coarse)").matches) {
  const preventPinchZoom = (event: Event) => event.preventDefault();
  document.addEventListener("gesturestart", preventPinchZoom, { passive: false });
  document.addEventListener("gesturechange", preventPinchZoom, { passive: false });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
