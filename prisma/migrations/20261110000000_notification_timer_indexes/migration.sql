-- P-09 of the speed audit (November 2026): the hourly timers delete notifications by kind and age
-- (src/lib/documents/access-notifications.ts), and no index served that, so each run was a sequential
-- scan of the table. An index only: no column, no row and no behaviour changes.
CREATE INDEX "Notification_kind_createdAt_idx" ON "Notification"("kind", "createdAt");
