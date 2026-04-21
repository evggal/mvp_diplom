from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field


jwt_secret = os.getenv("JWT_SECRET", "demo4-secret-key-change-me-32-bytes")
jwt_algorithm = "HS256"
token_lifetime_minutes = int(os.getenv("TOKEN_LIFETIME_MINUTES", "480"))
default_username = os.getenv("DEMO_USERNAME", "admin")
default_password = os.getenv("DEMO_PASSWORD", "admin")
demo_users = {default_username: default_password}

security_scheme = HTTPBearer(auto_error=False)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=100)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_at: str


def AuthenticateUser(username: str, password: str) -> bool:
    expected_password = demo_users.get(username)
    return expected_password is not None and expected_password == password


def CreateAccessToken(username: str) -> TokenResponse:
    expires_at = datetime.now(UTC) + timedelta(minutes=token_lifetime_minutes)
    payload = {
        "sub": username,
        "exp": expires_at,
        "iat": datetime.now(UTC),
    }
    token = jwt.encode(payload, jwt_secret, algorithm=jwt_algorithm)
    return TokenResponse(
        access_token=token,
        expires_at=expires_at.isoformat(),
    )


def DecodeToken(token: str) -> dict[str, str]:
    try:
        payload = jwt.decode(token, jwt_secret, algorithms=[jwt_algorithm])
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
        ) from exc
    return payload


def GetCurrentUser(
    credentials: HTTPAuthorizationCredentials | None = Depends(security_scheme),
) -> str:
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization token is required",
        )
    payload = DecodeToken(credentials.credentials)
    username = payload.get("sub")
    if not username:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token payload is invalid",
        )
    return username
