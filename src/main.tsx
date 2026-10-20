import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { AppThemeProvider } from "./platforms/app-config/theme-provider";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppThemeProvider>
      <App />
    </AppThemeProvider>
  </React.StrictMode>,
);
