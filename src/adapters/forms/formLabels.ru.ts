/**
 * Russian wording for the form templates.
 *
 * GENERATED — do not edit by hand. Regenerate with:
 *
 * ```
 * npm run wording:apply
 * ```
 *
 * which reads `wording.ru.txt` at the repository root and rewrites this file
 * whole. Editing here instead means the next regeneration silently discards the
 * change, and the fill-in file is the artefact the party actually reviews.
 *
 * An absent or empty entry leaves its slot pending, which renders bracketed on
 * the page. See `formLabels.ts`.
 */
export const RU_WORDING: Readonly<Record<string, string>> = {
  "brand": "Заря",
  "context.chainId": "Номер сети",
  "context.contract": "Адрес контракта",
  "context.organ": "Партийный орган",
  "context.votingId": "Номер голосования",
  "hint.approvalPercentage": "в базовых пунктах",
  "hint.approvalPercentageBase": "в базовых пунктах; 10000 это 100%",
  "hint.categoryName": "имя нумерованной категории",
  "hint.decimals": "от 0 до 255",
  "hint.duration": "в секундах",
  "hint.quorum": "точное количество голосов, не процент",
  "hint.value": "число с точностью, заданной для ячейки",
  "hint.x": "значение оси X из отчёта по состоянию Зари",
  "hint.y": "значение оси Y из отчёта по состоянию Зари",
  "input.approvalPercentage": "Процент для принятия решения",
  "input.approvalPercentageBase": "База процента для принятия решения",
  "input.category": "Номер категории",
  "input.categoryName": "Название категории",
  "input.decimals": "Точность",
  "input.duration": "Длительность",
  "input.matrix": "Выбор матрицы",
  "input.member": "Адрес коллеги",
  "input.newChairman": "Новый Председатель",
  "input.quorum": "Кворум",
  "input.statement": "Вопрос или Утверждение",
  "input.support": "Ваш голос",
  "input.theme": "Тема",
  "input.value": "Значение",
  "input.valueAuthor": "Автор значения",
  "input.x": "Тема (Ось X)",
  "input.y": "Вопрос или Утверждение (Ось Y)",
  "meta.operationRef": "Референс операции",
  "meta.operationType": "Тип операции",
  "meta.schemaVersion": "Версия формы",
  "operationTitle.CAST_VOTE": "Отдача голоса по вопросу",
  "operationTitle.CONFIGURE_ORGAN_THRESHOLDS": "Конфигурация параметров голосования для органа",
  "operationTitle.CREATE_CATEGORICAL_VALUE_VOTING": "Голосование о новом ответе на вопрос по категории",
  "operationTitle.CREATE_CATEGORY_VOTING": "Голосование о новой категории по вопросу",
  "operationTitle.CREATE_DECIMALS_VOTING": "Голосование о точности по вопросу",
  "operationTitle.CREATE_MEMBERSHIP_REVOCATION_VOTING": "Голосование об исключении из органа Партии",
  "operationTitle.CREATE_MEMBERSHIP_VOTING": "Голосование о членстве в органе Партии",
  "operationTitle.CREATE_NUMERICAL_VALUE_VOTING": "Голосование о новом ответе на вопрос по числовому значению",
  "operationTitle.CREATE_STATEMENT_VOTING": "Голосование о новом вопросе",
  "operationTitle.CREATE_THEME_VOTING": "Голосование о новой теме",
  "operationTitle.TRANSFER_CHAIRMANSHIP": "Передача прав Председателя",
  "option.AGAINST": "ПРОТИВ",
  "option.CATEGORICAL": "КАТЕГОРИАЛЬНАЯ",
  "option.FOR": "ЗА",
  "option.NUMERICAL": "ЧИСЛОВАЯ",
  "receipt.blockNumber": "Номер блока",
  "receipt.chainId": "Номер сети",
  "receipt.confirmedAt": "Время подтверждения",
  "receipt.signer": "Подписано",
  "receipt.status": "Статус",
  "receipt.txHash": "Хеш транзакции",
  "section.context": "Блок контекстуальных полей",
  "section.input": "Блок полей к заполнению",
  "section.receipt": "Блок полей проверки",
  "sentence.coordinateDisclosure": "Координаты должны соответствовать тем, которые были указаны в отчёте Зари, и сверяются с ним при загрузке файла формы обратно.",
  "sentence.instruction": "Заполнив все доступные к заполнению поля, пожалуйста, загрузите файл обратно в приложение.",
  "sentence.receiptNotice": "Блок полей проверки заполняется приложением автоматически после того, как файл успешно был обработан Зарёй.",
  "sentence.tamperNotice": "Значения контекстуальных полей не считываются из файла. Их редактирование ни на что не влияет.",
};
