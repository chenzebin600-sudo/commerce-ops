export class ScheduledTaskRepository {
  constructor({ schedulerRepository }) {
    this.schedulerRepository = schedulerRepository;
  }

  list(options) { return this.schedulerRepository.listTasks(options); }
  get(id) { return this.schedulerRepository.getTask(id); }
  save(input) { return this.schedulerRepository.saveTask(input); }
  setEnabled(id, enabled, nextRunAt) { return this.schedulerRepository.setTaskEnabled(id, enabled, nextRunAt); }
  updateScheduleState(id, state) { return this.schedulerRepository.updateTaskScheduleState(id, state); }
  softDelete(id, options) { return this.schedulerRepository.softDeleteTask(id, options); }
  restore(id, options) { return this.schedulerRepository.restoreTask(id, options); }
  due(now) { return this.schedulerRepository.dueTasks(now); }
}
