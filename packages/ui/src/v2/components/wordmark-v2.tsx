import { createUniqueId, type ComponentProps } from "solid-js"

export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g opacity="0.6">
        <g mask={`url(#${mask})`}>
          <g opacity="0.16">
            <path
              opacity="0.7"
              d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M33.2 6.8 42 28.3 50.8 6.8"
              stroke="currentColor"
              stroke-width="6"
              stroke-linejoin="miter"
              stroke-linecap="butt"
            />
            <path
              opacity="0.7"
              d="M84 24H66V30H84V36H60V6H84V24ZM66 18H78V12H66V18Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M108 12H96V36H90V6H108V12ZM114 24H108V12H114V24Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M144 12H126V30H144V36H120V6H144V12Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M168 12H156V30H168V12ZM174 36H150V6H174V36Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M198 12H186V30H198V12ZM204 36H180V6H198V0H204V36Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M216 12V18H228V12H216ZM234 24H216V30H234V36H210V6H234V24Z"
              fill="currentColor"
            />
          </g>
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="234" height="42">
          <rect width="234" height="42" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="117" y1="22" x2="117" y2="42" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
