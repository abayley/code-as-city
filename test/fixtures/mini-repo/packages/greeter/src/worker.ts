/** Background worker the greeter CLI starts at runtime. */
export function work(): void {
    process.stdout.write("working\n");
}

work();
