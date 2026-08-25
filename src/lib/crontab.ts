export type CrontabSchedule = { schedule: string; crontab: string };

/**
 * Extracts service schedules from crontab file texts: any line running a
 * compose service (`... run [--rm] <service> ...`) maps the service name to
 * the line's five leading cron fields.
 */
export function parseCrontabSchedules(crontabs: Iterable<readonly [string, string]>): Map<string, CrontabSchedule> {
    const schedules = new Map<string, CrontabSchedule>();
    for (const [crontab, text] of crontabs) {
        for (const line of text.split("\n")) {
            if (/^\s*(#|$)/.test(line)) continue;
            const service = /run\s+(?:--rm\s+)?([a-zA-Z0-9_-]+)/.exec(line)?.[1];
            const schedule = line.trim().split(/\s+/).slice(0, 5).join(" ");
            if (service !== undefined) schedules.set(service, { schedule, crontab });
        }
    }
    return schedules;
}
