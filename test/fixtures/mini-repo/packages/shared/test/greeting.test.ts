import { formatGreeting } from "../src/greeting";

if (formatGreeting("x") !== "hello, x") throw new Error("greeting failed");
