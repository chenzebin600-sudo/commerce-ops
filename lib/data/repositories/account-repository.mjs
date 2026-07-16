export class AccountRepository {
  constructor({ schedulerRepository }) {
    this.schedulerRepository = schedulerRepository;
  }

  list() { return this.schedulerRepository.listAccountProfiles(); }
  get(id, options) { return this.schedulerRepository.getAccountProfile(id, options); }
  findByUsername(username) { return this.schedulerRepository.findAccountProfileByUsername(username); }
  save(input) { return this.schedulerRepository.saveAccountProfile(input); }
  updateVerification(id, status, message) { return this.schedulerRepository.updateAccountVerification(id, status, message); }
  delete(id) { return this.schedulerRepository.deleteAccountProfile(id); }
}
