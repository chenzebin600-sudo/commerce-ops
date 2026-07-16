export class ScheduledRunRepository {
  constructor({ schedulerRepository }) {
    this.schedulerRepository = schedulerRepository;
  }

  create(input) { return this.schedulerRepository.createRun(input); }
  createIfAbsent(input) { return this.schedulerRepository.createRunIfAbsent(input); }
  list(filters) { return this.schedulerRepository.listRuns(filters); }
  get(id) { return this.schedulerRepository.getRun(id); }
  getDetails(id) { return this.schedulerRepository.getRunDetails(id); }
  claim(id) { return this.schedulerRepository.claimRun(id); }
  update(id, fields) { return this.schedulerRepository.updateRun(id, fields); }
  pending(limit) { return this.schedulerRepository.pendingRuns(limit); }
  addEvent(input) { return this.schedulerRepository.addRunEvent(input); }
  recoverStale(now, staleMs) { return this.schedulerRepository.recoverStaleRuns(now, staleMs); }
}
