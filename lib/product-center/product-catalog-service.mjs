export class ProductCatalogService {
  constructor({ repository }) {
    this.repository = repository;
  }

  list(options) {
    return this.repository.list(options);
  }

  detail(id) {
    return this.repository.get(id);
  }

  filters() {
    return this.repository.filters();
  }
}
