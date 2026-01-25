"""
Container challenge: child of Challenges with K8s-specific columns.
"""
from CTFd.models import Challenges, db


class ContainerChallenge(Challenges):
    __tablename__ = "container_challenges"
    __mapper_args__ = {"polymorphic_identity": "container"}

    id = db.Column(None, db.ForeignKey("challenges.id"), primary_key=True)
    image = db.Column(db.String(512), nullable=False)
    port = db.Column(db.Integer, nullable=False, default=80)
    command = db.Column(db.Text, nullable=True)
    connection_type = db.Column(db.String(32), nullable=False, default="http")  # http | tcp
    cpu_limit = db.Column(db.String(32), nullable=True)
    memory_limit = db.Column(db.String(32), nullable=False, default="256Mi")
    timeout = db.Column(db.Integer, nullable=True, default=3600)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
