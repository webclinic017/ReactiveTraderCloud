/* eslint-disable @typescript-eslint/ban-ts-comment */
import {
  ButtonStyle,
  CLISearchListenerRequest,
  CLISearchListenerResponse,
  CLITemplate,
  SearchResult,
  TemplateFragment,
} from "@openfin/workspace"
import {
  NlpIntentType,
  TradesInfoIntent,
} from "client/OpenFin/apps/Launcher/services/nlpService"
import {
  customNumberFormatter,
  DECIMAL_SEPARATOR,
  significantDigitsNumberFormatter,
} from "client/utils"
import * as CSS from "csstype"
import { format } from "date-fns"
// TODO - move into common place
import {
  ACK_CREATE_RFQ_RESPONSE,
  CurrencyPair,
  Direction,
} from "generated/TradingGateway"
import {
  combineLatest,
  filter,
  map,
  of,
  scan,
  Subscription,
  switchMap,
  take,
  takeUntil,
  withLatestFrom,
} from "rxjs"
import { getCreditRfqDetails$, RfqDetails } from "services/credit"
import { creditInstruments$ } from "services/credit/creditInstruments"
import {
  currencyPairs$,
  currencyPairSymbols$,
  getCurrencyPair$,
} from "services/currencyPairs"
import {
  executions$,
  ExecutionStatus,
  ExecutionTrade,
  TimeoutExecution,
} from "services/executions"
import { CreditExceededExecution } from "services/executions/types"
import { getPrice$, Price, PriceMovementType } from "services/prices"
import { trades$ } from "services/trades"

import { BASE_URL, VITE_RT_URL } from "../consts"
import {
  CreditRfqIntent,
  getNlpIntent,
  TradeExecutionIntent,
} from "../services/nlpService"
import {
  createButton,
  createContainer,
  createImage,
  createText,
  createTextContainer,
} from "../templates"
// TODO - move into common place
import { ADAPTIVE_LOGO, executing$, rfqResponse$ } from "./utils"

const MOVEMENT_UP_ICON = `${BASE_URL}/images/icons/up.svg`
const MOVEMENT_DOWN_ICON = `${BASE_URL}/images/icons/down.svg`

const formatSimple = customNumberFormatter()
const formatTo2Digits = significantDigitsNumberFormatter(2)
const formatTo3Digits = significantDigitsNumberFormatter(3)
const formatToMin2IntDigits = customNumberFormatter({
  minimumIntegerDigits: 2,
})

const getPriceBits = (price: number, currencyPair: CurrencyPair) => {
  const { ratePrecision, pipsPosition } = currencyPair
  const rateString = price.toFixed(ratePrecision)
  const [wholeNumber, fractions_] = rateString.split(".")
  const fractions = fractions_ || "00000"

  const pip = formatToMin2IntDigits(
    Number(fractions.substring(pipsPosition - 2, pipsPosition)),
  )
  const tenth = formatSimple(
    Number(fractions.substring(pipsPosition, pipsPosition + 1)),
  )

  const bigFigureNumber = Number(
    wholeNumber + "." + fractions.substring(0, pipsPosition - 2),
  )
  let bigFigure =
    bigFigureNumber < 1 && pipsPosition === 4
      ? formatTo2Digits(bigFigureNumber)
      : formatTo3Digits(bigFigureNumber)
  if (bigFigureNumber === Math.floor(bigFigureNumber))
    bigFigure += DECIMAL_SEPARATOR

  return {
    bigFigure,
    pip,
    tenth,
  }
}

const getBaseSpotTemplate = (price: Price): TemplateFragment => {
  const getPriceItem = (direction: "bid" | "ask") =>
    createContainer(
      "column",
      [
        createText(`${direction}Label`, 10, {
          opacity: 0.59,
          textTransform: "uppercase",
        }),
        createContainer(
          "row",
          [
            createText(`${direction}BigFigure`, 14, {}),
            createText(`${direction}Pip`, 36, { lineHeight: 1 }),
            createText(`${direction}Tenth`, 14, {}),
          ],
          { alignItems: "baseline", marginTop: "-14px" },
        ),
      ],
      { width: "35%" },
    )

  return createContainer("column", [
    createContainer(
      "row",
      [
        createText("symbol", 13, { fontWeight: "bold" }),
        createText("date", 11, { opacity: 0.59 }),
      ],
      {
        justifyContent: "space-between",
      },
    ),
    createContainer(
      "row",
      [
        getPriceItem("bid"),
        createContainer(
          "column",
          [
            createImage("movementUp", "Price Movement Up", {
              width: "10px",
              height: "10px",
              visibility:
                price.movementType === PriceMovementType.UP
                  ? "visible"
                  : "hidden",
            }),
            createText("spread", 12, {}),
            createImage("movementDown", "Price Movement Down", {
              width: "10px",
              height: "10px",
              visibility:
                price.movementType === PriceMovementType.DOWN
                  ? "visible"
                  : "hidden",
            }),
          ],
          {
            alignItems: "center",
          },
        ),
        getPriceItem("ask"),
      ],
      {
        justifyContent: "space-around",
        margin: "20px 0",
      },
    ),
  ])
}

const getSpotTemplate = (
  actions: { launch: string },
  price: Price,
): TemplateFragment => {
  return createContainer(
    "column",
    [
      getBaseSpotTemplate(price),
      createContainer(
        "row",
        [
          createButton(ButtonStyle.Secondary, "launchButton", actions.launch, {
            fontSize: "12px",
          }),
        ],
        { justifyContent: "flex-end", paddingTop: "10px" },
      ),
    ],
    {
      padding: "10px",
    },
  )
}

const getBaseSpotData = (price: Price, currencyPair: CurrencyPair) => {
  const { symbol, bid, ask, valueDate, spread } = price
  const bidPriceBits = getPriceBits(bid, currencyPair)
  const askPriceBits = getPriceBits(ask, currencyPair)

  return {
    symbol,
    bidBigFigure: bidPriceBits.bigFigure,
    bidPip: bidPriceBits.pip,
    bidTenth: bidPriceBits.tenth,
    askBigFigure: askPriceBits.bigFigure,
    askPip: askPriceBits.pip,
    askTenth: askPriceBits.tenth,
    date: `SPT (${format(new Date(valueDate), "dd MMM").toUpperCase()})`,
    askLabel: "Buy",
    bidLabel: "Sell",
    spread,
    movementUp: MOVEMENT_UP_ICON,
    movementDown: MOVEMENT_DOWN_ICON,
  }
}

const constructSpotResult = (price: Price, currencyPair: CurrencyPair) => {
  const { symbol } = price
  const LAUNCH_ACTION = `Launch ${symbol} tile`
  const TRADE_ACTION = `Trade ${symbol}`

  return {
    key: `spot-${symbol}`,
    title: symbol,
    label: "Currency Pair",
    icon: ADAPTIVE_LOGO,
    data: {
      symbol,
      manifestType: "url",
      manifest: `${VITE_RT_URL}/fx-spot/${symbol}`,
    },
    actions: [
      { name: LAUNCH_ACTION, hotkey: "enter" },
      { name: TRADE_ACTION, hotkey: "CmdOrCtrl+T" },
    ],
    template: CLITemplate.Custom,
    templateContent: {
      layout: getSpotTemplate({ launch: LAUNCH_ACTION }, price),
      data: {
        ...getBaseSpotData(price, currencyPair),
        launchButton: "Launch",
      },
    },
  }
}

const constructMarketTemplateContent = (
  prices: Price[],
  currencyPairs: Record<string, CurrencyPair>,
) => {
  const data = prices.reduce(
    (acc, cur) => {
      const currencyPair = currencyPairs[cur.symbol]
      const { bigFigure, pip, tenth } = getPriceBits(cur.mid, currencyPair)

      return {
        ...acc,
        [`${cur.symbol}Label`]: cur.symbol,
        [`${cur.symbol}BigFigure`]: bigFigure,
        [`${cur.symbol}Pip`]: pip,
        [`${cur.symbol}Tenth`]: tenth,
        [`${cur.symbol}Movement`]: cur.movementType,
      }
    },
    {
      movementUp: MOVEMENT_UP_ICON,
      movementDown: MOVEMENT_DOWN_ICON,
    },
  )

  const getTemplate = () => {
    return createContainer(
      "column",
      prices.map((price) =>
        createContainer(
          "row",
          [
            createText(`${price.symbol}Label`, 12, {
              opacity: 0.59,
              width: "64px",
            }),
            createContainer(
              "row",
              [
                createText(`${price.symbol}BigFigure`, 10, {}),
                createText(`${price.symbol}Pip`, 22, { lineHeight: 1 }),
                createText(`${price.symbol}Tenth`, 10, {}),
              ],
              { width: "60px", alignItems: "baseline" },
            ),
            createImage(
              price.movementType === PriceMovementType.UP
                ? "movementUp"
                : "movementDown",
              `Price Movement ${price.movementType}`,
              {
                width: "10px",
                height: "10px",
                alignSelf: "center",
                display:
                  price.movementType === PriceMovementType.NONE
                    ? "none"
                    : "block",
              },
            ),
          ],
          { alignItems: "flex-end", marginBottom: "6px" },
        ),
      ),
      {
        padding: "10px",
      },
    )
  }

  return {
    layout: getTemplate(),
    data,
  }
}

const constructTradeExecutionTemplateContent = (
  price: Price,
  currencyPair: CurrencyPair,
  notional: string,
  direction: Direction,
) => {
  const layout: TemplateFragment = createContainer(
    "column",
    [
      getBaseSpotTemplate(price),
      createContainer(
        "row",
        [
          createButton(
            ButtonStyle.Secondary,
            "executeButton", //TODO - const
            `Execute`,
            {
              fontSize: "12px",
            },
          ),
        ],
        { justifyContent: "center", paddingTop: "10px" },
      ),
    ],
    {
      padding: "10px",
    },
  )

  const data = {
    ...getBaseSpotData(price, currencyPair),
    executeButton: `${direction} - ${notional}`,
    notional,
    executingLoader: "Executing",
  }

  return {
    layout,
    data,
  }
}

const constructTradeExecutedTemplateContent = (
  trade: ExecutionTrade | CreditExceededExecution | TimeoutExecution,
) => {
  const fontSize = 12

  if (trade.status === ExecutionStatus.Done) {
    const inverseTextStyle: CSS.Properties = {
      backgroundColor: "white",
      color: "#01C38D",
      fontWeight: "bold",
    }
    const fontSize = 12

    const layout: TemplateFragment = createContainer(
      "column",
      [
        createTextContainer([createText("tradeId")], {
          fontWeight: "bold",
          marginBottom: "10px",
        }),
        createTextContainer([
          createText("direction", fontSize),
          createText("notional", fontSize, inverseTextStyle),
          createText("rateLabel", fontSize),
          createText("rate", fontSize, inverseTextStyle),
          createText("forLabel", fontSize),
          createText("amount", fontSize, {
            fontWeight: "bold",
            fontStyle: "italic",
          }),
          createText("settleLabel", fontSize),
          createText("settleDate", fontSize, { fontWeight: "bold" }),
        ]),
      ],
      {
        padding: "10px",
        height: "100%",
        justifyContent: "center",
        textAlign: "center",
        backgroundColor: "#01C38D",
        color: "white",
      },
    )

    const base = trade.currencyPair.slice(0, 3)
    const terms = trade.currencyPair.slice(3, 6)
    const data = {
      tradeId: `Trade ID: ${trade.tradeId.toString()}`,
      direction: `You ${
        trade.direction === Direction.Buy ? "bought" : "sold"
      } `,
      notional: `${base} ${nf.format(trade.notional)}`,
      rateLabel: " at a rate of ",
      rate: trade.spotRate.toString(),
      forLabel: " for ",
      amount: `${terms} ${nf.format(trade.notional * trade.spotRate)}`,
      settleLabel: ` settling (Spt) `,
      settleDate: format(new Date(trade.valueDate), "dd MMM"),
    }

    return {
      layout,
      data,
    }
  }

  const layout: TemplateFragment = createContainer(
    "column",
    [
      createTextContainer([createText("tradeId")], {
        fontWeight: "bold",
        marginBottom: "10px",
      }),
      createTextContainer([createText("rejectedLabel", fontSize)]),
    ],
    {
      padding: "10px",
      height: "100%",
      justifyContent: "center",
      textAlign: "center",
      backgroundColor: "#FF274B",
      color: "white",
    },
  )

  let data

  switch (trade.status) {
    case ExecutionStatus.Rejected:
      data = {
        tradeId: `Trade ID: ${trade.tradeId.toString()}`,
        rejectedLabel: "Your trade has been rejected",
      }
      break
    case ExecutionStatus.CreditExceeded:
      data = {
        tradeId: `Trade ID: NA`,
        rejectedLabel: "Credit limit exceeded",
      }
      break
    case ExecutionStatus.Timeout:
      data = {
        tradeId: `Trade ID: NA`,
        rejectedLabel: "Request timed out",
      }
      break
  }

  return {
    layout,
    data,
  }
}

const constructRfqRaisedTemplateContent = (rfqDetails?: RfqDetails | null) => {
  const fontSize = 12

  if (rfqDetails) {
    const { instrument } = rfqDetails

    const inverseTextStyle: CSS.Properties = {
      backgroundColor: "white",
      color: "#01C38D",
      fontWeight: "bold",
    }
    const fontSize = 12

    const layout: TemplateFragment = createContainer(
      "column",
      [
        createTextContainer([createText("rfqId")], {
          fontWeight: "bold",
          marginBottom: "10px",
        }),
        createTextContainer([
          createText("direction", fontSize),
          createText("notional", fontSize, inverseTextStyle),
        ]),
      ],
      {
        padding: "10px",
        height: "100%",
        justifyContent: "center",
        textAlign: "center",
        backgroundColor: "#01C38D",
        color: "white",
      },
    )

    const data = {
      rfqId: `RFQ ID: ${rfqDetails.id.toString()}`,
      direction: `You raised an RFQ to ${rfqDetails.direction} `,
      notional: `${nf.format(rfqDetails.quantity)} ${instrument?.ticker}`,
    }

    return {
      layout,
      data,
    }
  }

  const layout: TemplateFragment = createContainer(
    "column",
    [createTextContainer([createText("rejectedLabel", fontSize)])],
    {
      padding: "10px",
      height: "100%",
      justifyContent: "center",
      textAlign: "center",
      backgroundColor: "#FF274B",
      color: "white",
    },
  )

  const data = {
    rejectedLabel: "Your RFQ could not be raised",
  }

  return {
    layout,
    data,
  }
}

const nf = new Intl.NumberFormat("default")

export const getNlpResults = async (
  query: string,
  request: CLISearchListenerRequest,
  response: CLISearchListenerResponse,
) => {
  let loadingRevoked = false
  const intent = await getNlpIntent(query)

  const revokeLoading = () => {
    if (!loadingRevoked) {
      response.revoke("loading")
      loadingRevoked = true
    }
  }

  if (!intent) {
    return revokeLoading()
  }

  switch (intent.type) {
    case NlpIntentType.SpotQuote: {
      const { symbol } = intent.payload

      if (!symbol) {
        return revokeLoading()
      }

      const sub = getPrice$(symbol)
        .pipe(withLatestFrom(getCurrencyPair$(symbol)))
        .subscribe(([priceTick, currencyPair]) => {
          const result = constructSpotResult(priceTick, currencyPair)
          revokeLoading()
          response.respond([result])
        })

      request.onClose(() => {
        if (sub) {
          sub.unsubscribe()
        }
      })

      break
    }

    case NlpIntentType.MarketInfo: {
      const result = {
        key: `market`,
        title: "Market",
        label: "Live Rates",
        icon: ADAPTIVE_LOGO,
        data: {
          manifestType: "url",
          manifest: `${VITE_RT_URL}/fx-tiles`,
        },
        actions: [{ name: `Launch Live Rates`, hotkey: "enter" }],
        template: CLITemplate.Custom,
        templateContent: {},
      }

      const sub = currencyPairSymbols$
        .pipe(
          switchMap((symbols) => {
            const priceUpdates$ = symbols.map((symbol) => getPrice$(symbol))
            return combineLatest(priceUpdates$).pipe(
              scan((acc, prices) => {
                prices.forEach((price) => {
                  acc.set(price.symbol, price)
                })

                return acc
              }, new Map<string, Price>()),
            )
          }),
        )
        .pipe(withLatestFrom(currencyPairs$))
        .subscribe(([prices, currencyPairs]) => {
          result.templateContent = constructMarketTemplateContent(
            [...prices.values()],
            currencyPairs,
          )

          revokeLoading()
          response.respond([result])
        })

      request.onClose(() => {
        if (sub) {
          sub.unsubscribe()
        }
      })

      break
    }

    case NlpIntentType.TradeInfo: {
      const sub = trades$.subscribe((trades) => {
        trades.reverse()
        const trimmedTrades = (intent as TradesInfoIntent).payload.count
          ? trades.splice(0, (intent as TradesInfoIntent).payload.count)
          : trades
        const results = trimmedTrades.map((trade) => ({
          key: `trade-${trade.tradeId}`,
          title: `${trade.tradeId}`,
          label: "Trade",
          icon: ADAPTIVE_LOGO,
          data: {
            manifestType: "url",
            manifest: `${VITE_RT_URL}/fx-blotter`,
          },
          actions: [{ name: `Launch trades`, hotkey: "enter" }],
          template: CLITemplate.List,
          templateContent: [
            ["Trade ID", trade.tradeId],
            ["Status", trade.status],
            ["Trade Date", trade.tradeDate],
            ["Direction", trade.direction],
            ["CCYCCY", trade.currencyPair],
            ["Deal CCY", trade.dealtCurrency],
            ["Notional", nf.format(trade.notional)],
            ["Rate", trade.spotRate],
            ["Value Date", trade.valueDate],
            ["Trade", trade.tradeName],
          ],
        }))

        revokeLoading()
        response.respond(results)
      })

      request.onClose(() => {
        if (sub) {
          sub.unsubscribe()
        }
      })

      break
    }

    case NlpIntentType.TradeExecution: {
      const { direction, notional, symbol } = (intent as TradeExecutionIntent)
        .payload

      if (!symbol) {
        return revokeLoading()
      }

      const key = `trade-execution-${symbol}`
      const subs: Subscription[] = []
      let result: SearchResult

      subs.push(
        getPrice$(symbol)
          .pipe(
            withLatestFrom(getCurrencyPair$(symbol)),
            takeUntil(executing$.pipe(filter((value) => !!value))),
          )
          .subscribe(([price, currencyPair]) => {
            const { bid, ask } = price
            const formattedNotional = nf.format(notional)

            const data = {
              manifestType: "trade-execution",
              currencyPair: symbol,
              spotRate: direction === Direction.Buy ? ask : bid,
              valueDate: new Date().toISOString().substr(0, 10),
              direction,
              notional,
              dealtCurrency:
                direction === Direction.Buy
                  ? symbol.substr(0, 3)
                  : symbol.substr(3, 3),
            }

            result = {
              key,
              title: `${direction} ${formattedNotional} ${symbol}`,
              label: "Trade Execution",
              icon: ADAPTIVE_LOGO,
              data,
              actions: [{ name: `Execute`, hotkey: "enter" }],
              // @ts-ignore
              template: CLITemplate.Custom,
              templateContent: constructTradeExecutionTemplateContent(
                price,
                currencyPair,
                formattedNotional,
                direction,
              ),
            }

            revokeLoading()
            response.respond([result])
          }),
      )

      subs.push(
        executing$.pipe(take(1)).subscribe(() => {
          const newResult: SearchResult = { ...result }
          newResult.actions = []
          //@ts-ignore
          newResult.templateContent = {
            //@ts-ignore
            ...newResult.templateContent,
            layout: createContainer("column", [
              //@ts-ignore
              newResult.templateContent.layout,
              createContainer(
                "column",
                [
                  createText("executingLoader", 12, {
                    background: "rgb(95, 148, 245)",
                    padding: "16px 32px",
                    borderRadius: "32px",
                    margin: "auto ",
                  }),
                ],
                {
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  backgroundColor: "rgba(0,0,0,.3)",
                  zIndex: 2,
                },
              ),
            ]),
          }
          response.respond([newResult])
        }),
      )

      subs.push(
        executions$.pipe(take(1)).subscribe((trade) => {
          response.respond([
            {
              key,
              title: `Trade ${trade.status}`,
              label: "Trade Execution",
              icon: ADAPTIVE_LOGO,
              data: {
                manifestType: "url",
                manifest: `${VITE_RT_URL}/fx-blotter`,
              },
              actions: [{ name: `Launch Trades`, hotkey: "enter" }],
              // @ts-ignore
              template: CLITemplate.Custom,
              templateContent: constructTradeExecutedTemplateContent(trade),
            },
          ])
        }),
      )

      request.onClose(() => {
        if (subs.length) {
          subs.forEach((sub) => sub.unsubscribe())
        }
      })

      break
    }

    case NlpIntentType.CreditRfq: {
      const { symbol, direction, notional } = (intent as CreditRfqIntent)
        .payload

      const formattedNotional = nf.format(notional)

      if (!symbol) {
        return revokeLoading()
      }

      const key = `rfq-execution-${symbol}`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any

      const subs = creditInstruments$
        .pipe(
          map((instruments) =>
            instruments.find((instrument) => instrument.ticker === symbol),
          ),
        )
        .subscribe((instrument) => {
          if (!instrument) {
            return revokeLoading()
          }

          const { cusip, maturity, interestRate, benchmark, ticker } =
            instrument

          const data = {
            manifestType: "rfq-execution",
            instrumentId: instrument.id,
            quantity: notional,
            direction,
          }

          result = {
            key,
            title: `Raise RFQ: ${direction} ${formattedNotional} ${symbol}`,
            label: "RFQ Execution",
            icon: ADAPTIVE_LOGO,
            data,
            actions: [{ name: `Execute`, hotkey: "enter" }],
            // @ts-ignore
            template: CLITemplate.List,
            templateContent: [
              ["Ticker", ticker],
              ["Cusip", cusip],
              ["Maturity", maturity],
              ["Interest Rate", interestRate],
              ["Benchmark", benchmark],
            ],
          }

          revokeLoading()
          response.respond([result])
        })

      subs.add(
        rfqResponse$
          .pipe(
            switchMap((response) => {
              if (response.type === ACK_CREATE_RFQ_RESPONSE) {
                return getCreditRfqDetails$(response.payload)
              }
              return of(null)
            }),
          )
          .subscribe((rfqDetails) => {
            response.respond([
              {
                key,
                title: `RFQ ${rfqDetails ? "Raised" : "Failed to Raise"}`,
                label: "RFQ Execution",
                icon: ADAPTIVE_LOGO,
                data: {
                  manifestType: "url",
                  manifest: `${VITE_RT_URL}/credit-rfqs`,
                },
                actions: [{ name: `Launch RFQs`, hotkey: "enter" }],
                // @ts-ignore
                template: CLITemplate.Custom,
                templateContent: constructRfqRaisedTemplateContent(rfqDetails),
              },
            ])
          }),
      )

      request.onClose(() => {
        subs.unsubscribe()
      })

      break
    }

    default:
      return revokeLoading()
  }
}