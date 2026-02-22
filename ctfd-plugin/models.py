"""
Container challenge: child of Challenges with K8s-specific columns.
Two types: static container and dynamic container challenges.
Also includes ContainerEvent for team-wide lifecycle notifications.
"""
import time

from CTFd.models import Challenges, db


class ContainerEvent(db.Model):
    """Lightweight event log for team-wide container lifecycle notifications."""
    __tablename__ = "container_events"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    team_id = db.Column(db.String(64), nullable=False, index=True)
    challenge_id = db.Column(db.String(64), nullable=False)
    challenge_name = db.Column(db.String(256), nullable=True)
    event_type = db.Column(db.String(32), nullable=False)  # start, stop, reset, expired
    user_name = db.Column(db.String(256), nullable=True)
    timestamp = db.Column(db.Float, nullable=False, default=lambda: time.time())


class ContainerChallenge(Challenges):
    __tablename__ = "container_challenges"
    __mapper_args__ = {"polymorphic_identity": "container"}

    id = db.Column(None, db.ForeignKey("challenges.id", ondelete="CASCADE"), primary_key=True)
    image = db.Column(db.String(512), nullable=True)
    port = db.Column(db.Integer, nullable=True, default=80)
    command = db.Column(db.Text, nullable=True)
    connection_type = db.Column(db.String(32), nullable=True, default="http")  # http | tcp
    prefix = db.Column(db.String(64), nullable=True)  # Subdomain prefix for HTTP challenges
    cpu_limit = db.Column(db.String(32), nullable=True)
    memory_limit = db.Column(db.String(32), nullable=True, default="256Mi")
    timeout = db.Column(db.Integer, nullable=True, default=3600)

    def __init__(self, *args, **kwargs):
        from CTFd.exceptions.challenges import ChallengeCreateException
        
        super().__init__(*args, **kwargs)
        
        # Only validate when explicitly creating (kwargs present), not when loading from DB
        if kwargs:
            if not self.image:
                raise ChallengeCreateException("Docker image is required for container challenges")
            
            # Validate prefix is provided for HTTP challenges
            if self.connection_type == "http" and not self.prefix:
                raise ChallengeCreateException("Prefix is required for HTTP/web challenges")


class ContainerDynamicChallenge(Challenges):
    __tablename__ = "container_dynamic_challenges"
    __mapper_args__ = {"polymorphic_identity": "container-dynamic"}

    id = db.Column(None, db.ForeignKey("challenges.id", ondelete="CASCADE"), primary_key=True)
    image = db.Column(db.String(512), nullable=True)
    port = db.Column(db.Integer, nullable=True, default=80)
    command = db.Column(db.Text, nullable=True)
    connection_type = db.Column(db.String(32), nullable=True, default="http")  # http | tcp
    prefix = db.Column(db.String(64), nullable=True)  # Subdomain prefix for HTTP challenges
    cpu_limit = db.Column(db.String(32), nullable=True)
    memory_limit = db.Column(db.String(32), nullable=True, default="256Mi")
    timeout = db.Column(db.Integer, nullable=True, default=3600)
    # Dynamic value fields - use prefixed names to avoid conflicts with base Challenges table
    container_initial = db.Column(db.Integer, nullable=True)
    container_decay_function = db.Column(db.String(32), nullable=True, default="linear")  # linear | logarithmic
    container_decay = db.Column(db.Integer, nullable=True)
    container_minimum = db.Column(db.Integer, nullable=True)

    @property
    def initial(self):
        return self.container_initial

    @initial.setter
    def initial(self, value):
        self.container_initial = value

    @property
    def initial_value(self):
        return self.container_initial

    @initial_value.setter
    def initial_value(self, value):
        self.container_initial = value

    @property
    def minimum(self):
        return self.container_minimum

    @minimum.setter
    def minimum(self, value):
        self.container_minimum = value

    @property
    def minimum_value(self):
        return self.container_minimum

    @minimum_value.setter
    def minimum_value(self, value):
        self.container_minimum = value

    @property
    def decay(self):
        return self.container_decay

    @decay.setter
    def decay(self, value):
        self.container_decay = value

    @property
    def function(self):
        return self.container_decay_function

    @function.setter
    def function(self, value):
        self.container_decay_function = value

    @property
    def decay_function(self):
        return self.container_decay_function

    @decay_function.setter
    def decay_function(self, value):
        self.container_decay_function = value

    def __init__(self, *args, **kwargs):
        from CTFd.exceptions.challenges import ChallengeCreateException
        
        super().__init__(*args, **kwargs)
        
        # Only validate when explicitly creating (kwargs present), not when loading from DB
        if kwargs:
            # Validate required fields
            if not self.image:
                raise ChallengeCreateException("Docker image is required for container challenges")
            
            # Validate prefix is provided for HTTP challenges
            if self.connection_type == "http" and not self.prefix:
                raise ChallengeCreateException("Prefix is required for HTTP/web challenges")
            
            # Handle initial value - can come as "initial" or "initial_value"
            if "initial" in kwargs and not self.container_initial:
                self.container_initial = kwargs["initial"]
            if "initial_value" in kwargs and not self.container_initial:
                self.container_initial = kwargs["initial_value"]
            
            if self.container_initial is None:
                raise ChallengeCreateException("Initial value is required for dynamic challenges")
            
            if self.container_decay is None:
                raise ChallengeCreateException("Decay is required for dynamic challenges")
            
            if self.container_minimum is None:
                raise ChallengeCreateException("Minimum value is required for dynamic challenges")
            
            # Set the challenge value to initial value
            self.value = self.container_initial
