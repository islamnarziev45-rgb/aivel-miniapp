"""AIVEL VPN Telegram entry bot. Business state lives in the Mini App backend."""

import asyncio
import json
import os
import re
from urllib.request import Request, urlopen

from aiogram import Bot, Dispatcher, F
from collections import defaultdict
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
AIVEL_API_URL = os.getenv("AIVEL_API_URL", "http://127.0.0.1:18080").rstrip("/")

dp = Dispatcher()
home_menu_message_ids: dict[int, list[int]] = defaultdict(list)


def app_url(screen: str) -> str:
    return f"{MINI_APP_URL}/?startapp={screen}"


def web_app_button(text: str, screen: str, style: str | None = None) -> InlineKeyboardButton:
    options = {"text": text, "web_app": WebAppInfo(url=app_url(screen))}
    if style:
        options["style"] = style
    return InlineKeyboardButton(**options)


def inline_menu(referrer_id: str | None = None, show_trial: bool = True) -> InlineKeyboardMarkup:
    first_screen = f"ref_{referrer_id}" if referrer_id else "trial"
    first_title = ("🎁 Принять приглашение · 2 дня" if show_trial else "🎁 Приглашение") if referrer_id else "🎁 Бесплатный старт · 2 дня"
    rows = []
    if referrer_id or show_trial:
        rows.append([web_app_button(first_title, first_screen, "primary")])
    rows.extend([
            [
                web_app_button("💳 Купить / Продлить", "tariffs", "success"),
                web_app_button("🔗 Моя подписка", "profile", "primary"),
            ],
            [web_app_button("📲 Подключить устройство", "install")],
            [
                InlineKeyboardButton(text="💬 Поддержка", url="https://t.me/aivel_support"),
                web_app_button("📄 Соглашение", "agreement"),
            ],
        ])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def api_post(path: str, payload: dict) -> dict:
    request = Request(
        f"{AIVEL_API_URL}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Aivel-Bot-Token": BOT_TOKEN},
        method="POST",
    )
    with urlopen(request, timeout=8) as response:
        return json.loads(response.read().decode("utf-8"))


async def get_trial_available(telegram_id: int) -> bool:
    try:
        result = await asyncio.to_thread(
            api_post, "/bot/trial-status", {"telegram_id": str(telegram_id)}
        )
        return result.get("trial_available") is True
    except Exception as error:
        print(f"Trial status lookup failed: {type(error).__name__}", flush=True)
        return False


async def register_menu(telegram_id: int, chat_id: int, message_id: int, markup: InlineKeyboardMarkup) -> None:
    try:
        await asyncio.to_thread(
            api_post,
            "/bot/register-menu",
            {
                "telegram_id": str(telegram_id),
                "chat_id": str(chat_id),
                "message_id": message_id,
                "reply_markup": markup.model_dump(mode="json"),
            },
        )
    except Exception as error:
        print(f"Menu registration failed: {type(error).__name__}", flush=True)


def persistent_menu() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [
                KeyboardButton(text="Главный экран 🏠")
            ]
        ],
        resize_keyboard=True,
        is_persistent=True,
    )


async def clear_previous_home_menu(message: Message, delete_request: bool = False) -> None:
    chat_id = message.chat.id
    for message_id in home_menu_message_ids.pop(chat_id, []):
        try:
            await message.bot.delete_message(chat_id, message_id)
        except Exception:
            pass
    if delete_request:
        try:
            await message.delete()
        except Exception:
            pass


async def show_home_menu(message: Message, referrer_id: str | None = None) -> None:
    await clear_previous_home_menu(
        message,
        delete_request=(message.text or "").strip() == "Главный экран 🏠",
    )
    show_trial = await get_trial_available(message.from_user.id)
    greeting = await message.answer(
        "🛡 <b>AIVEL VPN</b>\n\n"
        + ("Вас пригласили в AIVEL VPN. Откройте приложение по кнопке ниже, чтобы приглашение засчиталось.\n\n" if referrer_id else ("Откройте Mini App, чтобы активировать пробный период, управлять подпиской и подключить устройство.\n\n" if show_trial else "Откройте Mini App, чтобы управлять подпиской и подключить устройство.\n\n"))
        + "Тарифы: 1 месяц — <b>80 ₽</b> · 3 месяца — <b>190 ₽</b> · "
        "6 месяцев — <b>390 ₽</b>.",
        parse_mode="HTML",
        reply_markup=persistent_menu(),
    )
    markup = inline_menu(referrer_id, show_trial=show_trial)
    menu = await message.answer(
        "Выберите действие — кнопки ниже откроют нужный раздел:",
        reply_markup=markup,
    )
    home_menu_message_ids[message.chat.id] = [greeting.message_id, menu.message_id]
    await register_menu(message.from_user.id, message.chat.id, menu.message_id, markup)


@dp.message(CommandStart())
async def start(message: Message) -> None:
    parts = (message.text or "").split(maxsplit=1)
    payload = parts[1].strip() if len(parts) > 1 else ""
    referrer_id = None
    if re.fullmatch(r"ref_[1-9]\d{0,15}", payload):
        referrer_id = payload[4:]
    await show_home_menu(message, referrer_id)


@dp.message(F.text == "Главный экран 🏠")
async def show_home_button(message: Message) -> None:
    await show_home_menu(message)


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
