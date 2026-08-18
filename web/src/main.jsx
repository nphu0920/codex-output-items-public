import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { installThemeSync } from "./theme.js";
import "./styles.css";

installThemeSync();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
