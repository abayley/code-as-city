// Browser entry point for the three.js city-map viewer: mounts the RepoCity
// application (react-three-fiber scene plus UI chrome) into the #root element.
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/error-boundary";
import RepoCity from "./RepoCity";
import "./globals.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element.");
createRoot(rootElement).render(
    <ErrorBoundary>
        <RepoCity />
    </ErrorBoundary>,
);
