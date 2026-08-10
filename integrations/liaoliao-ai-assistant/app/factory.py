from __future__ import annotations

from dataclasses import dataclass

from .assistant import ReplyAssistant
from .browser import BrowserCollector
from .central_client import CentralControlPlaneClient
from .config import Settings
from .db import Database
from .llm import OpenAICompatibleLLM, SuggestionService
from .knowledge import KnowledgeBase
from .logging_setup import configure_logging
from .repository import Repository
from .service import ApplicationService


@dataclass(slots=True)
class Runtime:
    settings: Settings
    repository: Repository
    collector: BrowserCollector
    suggestions: SuggestionService
    service: ApplicationService
    assistant: ReplyAssistant | None = None
    central: CentralControlPlaneClient | None = None


def build_runtime(settings: Settings | None = None, *, verbose: bool = False) -> Runtime:
    settings = settings or Settings.from_env()
    settings.ensure_directories()
    logger = configure_logging(settings.log_dir, verbose=verbose)
    repository = Repository(Database(settings.database_path))
    repository.initialize()
    collector = BrowserCollector(settings, logger.getChild("browser"))
    central = CentralControlPlaneClient(settings, logger.getChild("central"))
    llm = OpenAICompatibleLLM(settings, logger.getChild("llm"))
    knowledge = KnowledgeBase(settings.knowledge_dir)
    suggestions = SuggestionService(
        repository, llm, settings, knowledge, logger.getChild("suggestions")
    )
    service = ApplicationService(
        repository, collector, suggestions, logger.getChild("service"), central
    )
    assistant = ReplyAssistant(
        repository, collector, suggestions, logger.getChild("assistant"), central
    )
    return Runtime(settings, repository, collector, suggestions, service, assistant, central)
