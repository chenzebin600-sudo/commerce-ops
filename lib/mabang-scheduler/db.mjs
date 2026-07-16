// Compatibility entry point. SQLite-specific persistence lives in the data adapter.
export {
  SchedulerDatabase,
  openSchedulerDatabase,
} from "../data/sqlite/sqlite-scheduler-repository.mjs";
