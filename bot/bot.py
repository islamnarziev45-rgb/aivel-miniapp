"""AIVEL VPN Telegram entry bot. Business state lives in the Mini App backend."""

import asyncio
import os

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


def inline_menu() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [web_app_button("🎁 Бесплатный старт · 2 дня / 5 ГБ", "trial")],
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
    await message.answer(
        "🛡 <b>AIVEL VPN</b>\n\n"
        "Откройте Mini App, чтобы активировать пробный период, управлять подпиской "
        "и подключить устройство.\n\n"
        "Тарифы: 1 месяц — <b>80 ₽</b> · 3 месяца — <b>190 ₽</b> · "
        "6 месяцев — <b>390 ₽</b>.",
        parse_mode="HTML",
        reply_markup=persistent_menu(),
    )
    await message.answer(
        "Выберите действие — кнопки откроют нужный раздел Mini App:",
        reply_markup=inline_menu(),
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
