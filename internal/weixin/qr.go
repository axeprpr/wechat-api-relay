package weixin

import (
	"os"

	qrterminal "github.com/mdp/qrterminal/v3"
)

func PrintQRCode(content string) error {
	qrterminal.GenerateHalfBlock(content, qrterminal.L, os.Stdout)
	return nil
}
