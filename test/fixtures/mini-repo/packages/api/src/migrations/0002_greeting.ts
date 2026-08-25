/** Adds the greeting column. */
export function up(): string {
    return "alter table minis add greeting";
}
