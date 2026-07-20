; Example CP/M Hello World Program
; Z80 Assembly
; 
; This program demonstrates basic CP/M system calls
; Assemble with: z80asm hello.asm -o hello.com

; CP/M System call entry point
BDOS    EQU 5           ; BDOS entry point
CPM_EXIT EQU 0          ; Exit to CP/M
CPM_PRINT EQU 9         ; Print string

        ORG 0100h       ; CP/M COM file origin

        LD C, CPM_PRINT ; Load function code (print string)
        LD DE, MSG      ; Load address of message
        CALL BDOS       ; Call BDOS

        LD C, CPM_EXIT  ; Load exit function code
        CALL BDOS       ; Exit to CP/M

; Message to display
MSG:    DB 'Hello, CP/M World!$'

        END
