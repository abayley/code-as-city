import { createRoot } from "react-dom/client";
import RepoCity from "./RepoCity";
import "./globals.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element.");
createRoot(rootElement).render(<RepoCity />);
