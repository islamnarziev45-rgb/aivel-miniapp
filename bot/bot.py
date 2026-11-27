"""AIVEL VPN Telegram entry bot. Business state lives in the Mini App backend."""

import asyncio
import os
import re

from aiogram import Bot, Dispatcher
from aiogram.filters import CommandStart
from aiogram.types import (
    KeyboardButton,
    Message,
    ReplyKeyboardMarkup,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    WebAppInfo,
)


BOT_TOKEN = os.getenv("AIVEL_BOT_TOKEN") or os.getenv("BOT_TOKEN", "")
MINI_APP_URL = os.getenv(
    "MINI_APP_URL",
    "https://islamnarziev45-rgb.github.io/aivel-miniapp/",
).rstrip("/")

dp = Dispatcher()


def app_url(screen: str) -> str:
    return f"{MINI_APP_URL}/?startapp={screen}"


def web_app_button(text: str, screen: str) -> InlineKeyboardButton:
    return InlineKeyboardButton(text=text, web_app=WebAppInfo(url=app_url(screen)))


def inline_menu(referrer_id: str | None = None) -> InlineKeyboardMarkup:
    first_screen = f"ref_{referrer_id}" if referrer_id else "trial"
    first_title = "🎁 Принять приглашение · 2 дня / 5 ГБ" if referrer_id else "🎁 Бесплатный старт · 2 дня / 5 ГБ"
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [web_app_button(first_title, first_screen)],
            [
                web_app_button("💳 Купить / Продлить", "tariffs"),
                web_app_button("🔗 Моя подписка", "profile"),
            ],
            [web_app_button("📲 Установить AIVEL VPN", "install")],
            [
                web_app_button("💬 Поддержка", "support"),
                web_app_button("📄 Соглашение", "agreement"),
            ],
        ]
    )


def persistent_menu() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [
                KeyboardButton(
                    text="🚀 Открыть AIVEL VPN",
                    web_app=WebAppInfo(url=app_url("home")),
                )
            ]
        ],
        resize_keyboard=True,
        is_persistent=True,
    )


@dp.message(CommandStart())
async def start(message: Message) -> None:
    parts = (message.text or "").split(maxsplit=1)
    payload = parts[1].strip() if len(parts) > 1 else ""
    referrer_id = None
    if re.fullmatch(r"ref_[1-9]\d{0,15}", payload):
        referrer_id = payload[4:]

    await message.answer(
        "🛡 <b>AIVEL VPN</b>\n\n"
        + ("Вас пригласили в AIVEL VPN. Откройте приложение по кнопке ниже, чтобы приглашение засчиталось.\n\n" if referrer_id else "Откройте Mini App, чтобы активировать пробный период, управлять подпиской ")
        + ("" if referrer_id else "и подключить устройство.\n\n")
        + "Тарифы: 1 месяц — <b>80 ₽</b> · 3 месяца — <b>190 ₽</b> · "
        "6 месяцев — <b>390 ₽</b>.",
        parse_mode="HTML",
        reply_markup=persistent_menu(),
    )
    await message.answer(
        "Нажмите кнопку — она откроет Mini App:",
        reply_markup=inline_menu(referrer_id),
    )


async def main() -> None:
    if not BOT_TOKEN:
        raise RuntimeError("Set AIVEL_BOT_TOKEN in the service environment")

    bot = Bot(token=BOT_TOKEN)
    try:
        await dp.start_polling(bot)
    finally:
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())

