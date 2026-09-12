import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// The original hackathon artifact expects window.storage. This shim
// makes it runnable in a normal Vite browser using localStorage.
if (!window.storage) {
  window.storage = {
    async get(key) {
      const value = localStorage.getItem(key);
      return value === null ? null : { value };
    },
    async set(key, value) {
      localStorage.setItem(key, value);
      return { value };
    },
    async delete(key) {
      localStorage.removeItem(key);
      return true;
    },
  };
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <App />
);
