import express from "express";

/** Serves the web client's built bundle (SERVE_UI). */
export const ui = express.static("../../web/dist");
